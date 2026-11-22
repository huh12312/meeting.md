import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, MEDIA_DIR } from './config.js';
import { one, all, run, newId, now } from './db.js';
import { sendTo, broadcast } from './ws.js';
import { Segmenter, SAMPLE_RATE, transcribe, sttConfigured } from './stt.js';
import { describeImage, llmConfigured } from './llm.js';

const PCM_BYTES_PER_SECOND = SAMPLE_RATE * 2;
const RETRY_MS = 1000;
const workers = new Map(); // rtstream id -> StreamWorker
const sceneLoops = new Map(); // scene index id -> timer

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log('[media]', ...args);

function emit(owner, connectionId, message) {
  if (!sendTo(connectionId, message)) broadcast(owner, message);
}

/**
 * Pulls one published RTSP stream back out of the media server, writes it to
 * disk untouched, and (for audio) taps a 16 kHz PCM copy for transcription.
 */
class StreamWorker {
  constructor(stream) {
    this.stream = stream;
    this.url = `${config.rtspInternalUrl}/${stream.id}`;
    this.stopped = false;
    this.proc = null;
    this.attempt = 0;
    this.transcription = { enabled: false, wsConnectionId: null, languageCode: null };
    this.lag = { count: 0, total: 0, max: 0, warned: false };
    this.queue = Promise.resolve();
    this.done = this.loop();
  }

  async loop() {
    while (!this.stopped) {
      await this.capture();
      if (!this.stopped) await sleep(RETRY_MS);
    }
  }

  capture() {
    const { stream } = this;
    const file = `${stream.id}.${this.attempt++}.mkv`;
    const filePath = path.join(MEDIA_DIR, file);
    const isAudio = stream.media_type === 'audio';

    const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', this.url];
    if (isAudio) {
      args.push('-map', '0:a:0', '-c', 'copy', '-f', 'matroska', filePath);
      args.push('-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1');
    } else {
      args.push('-map', '0:v:0', '-c', 'copy', '-f', 'matroska', filePath);
      args.push('-progress', 'pipe:1', '-stats_period', '0.5');
    }

    return new Promise((resolve) => {
      const proc = spawn(config.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      let segmentId = null;
      let startedAt = null;
      let stderr = '';

      const begin = (at) => {
        startedAt = at;
        segmentId = run(
          'INSERT INTO segments (rtstream_id, file, started_at) VALUES (?, ?, ?)',
          stream.id, file, at
        ).lastInsertRowid;
        run("UPDATE rtstreams SET status = 'connected' WHERE id = ?", stream.id);
        log(`${stream.channel_id} (${stream.id}) receiving`);
      };

      const segmenter = isAudio
        ? new Segmenter((segment) => this.onUtterance(segment, startedAt))
        : null;

      proc.stdout.on('data', (chunk) => {
        if (isAudio) {
          if (startedAt === null) begin(Date.now() / 1000 - chunk.length / PCM_BYTES_PER_SECOND);
          segmenter.push(chunk);
          return;
        }
        if (startedAt === null) {
          const match = /out_time_us=(\d+)/.exec(chunk.toString());
          if (match && Number(match[1]) > 0) begin(Date.now() / 1000 - Number(match[1]) / 1e6);
        }
      });
      proc.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      proc.stdin.on('error', () => {});
      proc.on('error', (err) => {
        log(`ffmpeg failed to start: ${err.message}`);
        resolve();
      });
      proc.on('exit', () => {
        this.proc = null;
        if (segmenter) segmenter.flush();
        if (segmentId !== null) {
          run('UPDATE segments SET ended_at = ? WHERE id = ?', Date.now() / 1000, segmentId);
          if (!this.stopped) log(`${stream.channel_id} (${stream.id}) dropped: ${stderr.trim().split('\n').pop() || 'eof'}`);
        } else {
          // Publisher not there yet; leave nothing behind.
          fs.rm(filePath, { force: true }, () => {});
        }
        resolve();
      });
    });
  }

  onUtterance(segment, startedAt) {
    const { enabled, wsConnectionId, languageCode } = this.transcription;
    if (!enabled || !sttConfigured()) return;
    const { stream } = this;
    const start = startedAt + segment.start;
    const end = startedAt + segment.end;

    // Serialised so finals arrive in spoken order even when requests overlap.
    this.queue = this.queue.then(async () => {
      try {
        const text = await transcribe(segment.pcm, languageCode);
        this.trackLag(Date.now() / 1000 - end);
        if (!text) return;
        run(
          'INSERT INTO transcripts (rtstream_id, session_id, start, end, text) VALUES (?, ?, ?, ?, ?)',
          stream.id, stream.session_id, start, end, text
        );
        emit(stream.owner, wsConnectionId, {
          channel: 'transcript',
          rtstream_id: stream.id,
          rtstream_name: stream.name,
          data: { text, is_final: true, start, end },
        });
      } catch (err) {
        log(`transcription failed for ${stream.id}: ${err.message}`);
      }
    });
  }

  /** Seconds between an utterance ending and its text being ready. */
  trackLag(seconds) {
    const { lag, stream } = this;
    lag.count++;
    lag.total += seconds;
    lag.max = Math.max(lag.max, seconds);
    if (seconds > config.stt.lagWarnSeconds && !lag.warned) {
      lag.warned = true;
      log(`transcription of ${stream.channel_id} is ${seconds.toFixed(0)}s behind live; the STT model is too slow for this machine (try a smaller STT_MODEL or a GPU)`);
    }
  }

  async stop() {
    this.stopped = true;
    const proc = this.proc;
    if (proc) {
      proc.stdin.write('q'); // lets ffmpeg finalise the container
      const kill = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await this.done;
      clearTimeout(kill);
    } else {
      await this.done;
    }
    await this.queue;
    if (this.lag.count) {
      log(`${this.stream.channel_id}: ${this.lag.count} utterances transcribed, lag mean ${(this.lag.total / this.lag.count).toFixed(1)}s, max ${this.lag.max.toFixed(1)}s`);
    }
    run("UPDATE rtstreams SET status = 'stopped' WHERE id = ?", this.stream.id);
  }
}

export function startStream(stream) {
  if (!workers.has(stream.id)) workers.set(stream.id, new StreamWorker(stream));
}

export function setTranscription(streamId, settings) {
  const worker = workers.get(streamId);
  if (!worker) return false;
  Object.assign(worker.transcription, settings);
  return true;
}

export async function stopSessionStreams(sessionId) {
  const streams = all('SELECT id FROM rtstreams WHERE session_id = ?', sessionId);
  for (const { id } of all(
    'SELECT si.id FROM scene_indexes si JOIN rtstreams r ON r.id = si.rtstream_id WHERE r.session_id = ?',
    sessionId
  )) {
    stopSceneIndex(id);
  }
  await Promise.all(
    streams.map(async ({ id }) => {
      const worker = workers.get(id);
      if (worker) {
        await worker.stop();
        workers.delete(id);
      }
    })
  );
}

// ---------------------------------------------------------------- scene index

function grabFrame(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      config.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url,
        '-frames:v', '1', '-vf', 'scale=1280:-2', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const chunks = [];
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20000);
    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.on('error', reject);
    proc.on('exit', () => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(chunks);
      if (jpeg.length) resolve(jpeg);
      else reject(new Error('no frame'));
    });
  });
}

export function startSceneIndex(id) {
  if (sceneLoops.has(id)) return;
  const index = one('SELECT * FROM scene_indexes WHERE id = ?', id);
  const stream = index && one('SELECT * FROM rtstreams WHERE id = ?', index.rtstream_id);
  if (!stream) return;
  const period = Math.max(5, Number(JSON.parse(index.extraction_config || '{}').time) || 10);
  const prompt = index.prompt || 'Describe what is visible on the screen.';
  let busy = false;

  const tick = async () => {
    if (busy || !llmConfigured()) return;
    busy = true;
    const start = Date.now() / 1000;
    try {
      const jpeg = await grabFrame(`${config.rtspInternalUrl}/${stream.id}`);
      const text = (await describeImage(jpeg, prompt)).trim();
      if (text && sceneLoops.has(id)) {
        const end = Date.now() / 1000;
        run('INSERT INTO scenes (scene_index_id, start, end, text) VALUES (?, ?, ?, ?)', id, start, end, text);
        emit(stream.owner, index.ws_connection_id, {
          channel: 'scene_index',
          rtstream_id: stream.id,
          rtstream_name: stream.name,
          index_id: id,
          data: { text, start, end },
        });
      }
    } catch (err) {
      log(`scene index ${id}: ${err.message}`);
    } finally {
      busy = false;
    }
  };

  sceneLoops.set(id, setInterval(tick, period * 1000));
  run("UPDATE scene_indexes SET status = 'connected' WHERE id = ?", id);
}

export function stopSceneIndex(id) {
  clearInterval(sceneLoops.get(id));
  sceneLoops.delete(id);
  run("UPDATE scene_indexes SET status = 'stopped' WHERE id = ?", id);
}

// --------------------------------------------------------------------- export

function ffmpegRun(args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited ${code}`));
    });
  });
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const proc = spawn(
      config.ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let out = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.on('error', () => resolve(0));
    proc.on('exit', () => resolve(Number(out.trim()) || 0));
  });
}

/**
 * Muxes a stopped session into one MP4: the primary screen track copied as-is,
 * every stored audio track delayed to its wall-clock offset and mixed down.
 */
export async function exportSession(sessionId) {
  const session = one('SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!session || session.exported_video_id || session.export_status === 'exporting') return;
  run("UPDATE sessions SET export_status = 'exporting' WHERE id = ?", sessionId);

  try {
    const segments = all(
      `SELECT s.*, r.media_type, r.is_primary, r.channel_id FROM segments s
       JOIN rtstreams r ON r.id = s.rtstream_id
       WHERE r.session_id = ? AND r.store = 1 AND s.started_at IS NOT NULL
       ORDER BY s.started_at`,
      sessionId
    ).filter((segment) => {
      try {
        return fs.statSync(path.join(MEDIA_DIR, segment.file)).size > 0;
      } catch {
        return false;
      }
    });
    if (!segments.length) throw new Error('no media was received for this session');

    const origin = Math.min(...segments.map((segment) => segment.started_at));
    const videos = segments.filter((segment) => segment.media_type === 'video');
    const video =
      videos.find((segment) => segment.channel_id === session.primary_video_channel_id) ||
      videos.find((segment) => segment.is_primary) ||
      videos[0];
    const audios = segments.filter((segment) => segment.media_type === 'audio');

    const videoId = newId('m');
    const file = `${videoId}.mp4`;
    const args = [];
    const maps = [];
    let input = 0;

    if (video) {
      args.push('-itsoffset', (video.started_at - origin).toFixed(3), '-i', path.join(MEDIA_DIR, video.file));
      maps.push('-map', `${input++}:v:0`, '-c:v', 'copy');
    }
    if (audios.length) {
      const labels = [];
      const filters = audios.map((segment) => {
        args.push('-i', path.join(MEDIA_DIR, segment.file));
        const delay = Math.max(0, Math.round((segment.started_at - origin) * 1000));
        const label = `a${input}`;
        labels.push(`[${label}]`);
        return `[${input++}:a:0]aresample=48000,adelay=${delay}:all=1[${label}]`;
      });
      filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[mix]`);
      args.push('-filter_complex', filters.join(';'));
      maps.push('-map', '[mix]', '-c:a', 'aac', '-b:a', '128k');
    }
    await ffmpegRun([...args, ...maps, '-movflags', '+faststart', path.join(MEDIA_DIR, file)]);

    const length = await probeDuration(path.join(MEDIA_DIR, file));
    const meta = JSON.parse(session.metadata || '{}');
    const name = meta.name || meta.title || `Recording ${new Date(origin * 1000).toISOString().slice(0, 16).replace('T', ' ')}`;
    run(
      'INSERT INTO videos (id, owner, collection_id, session_id, name, length, size, file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      videoId, session.owner, session.collection_id, sessionId, name, length,
      fs.statSync(path.join(MEDIA_DIR, file)).size, file, now()
    );
    run("UPDATE sessions SET exported_video_id = ?, export_status = 'exported', status = 'exported' WHERE id = ?", videoId, sessionId);
    log(`session ${sessionId} exported as ${videoId} (${length.toFixed(1)}s)`);
    if (!config.keepRawSegments) {
      for (const segment of segments) fs.rm(path.join(MEDIA_DIR, segment.file), { force: true }, () => {});
    }
    emit(session.owner, session.ws_connection_id, {
      channel: 'capture_session',
      event: 'capture_session.exported',
      capture_session_id: sessionId,
      data: { exported_video_id: videoId },
    });
  } catch (err) {
    log(`export of ${sessionId} failed: ${err.message}`);
    run("UPDATE sessions SET export_status = 'failed' WHERE id = ?", sessionId);
  }
}

export async function shutdown() {
  await Promise.all([...workers.values()].map((worker) => worker.stop()));
}
