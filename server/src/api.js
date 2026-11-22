import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { config, MEDIA_DIR } from './config.js';
import { one, all, run, newId, now, getCollection, defaultCollection } from './db.js';
import { broadcast, sendTo } from './ws.js';
import { complete, forwardChatCompletion, llmConfigured } from './llm.js';
import {
  startStream, setTranscription, stopSessionStreams, exportSession,
  startSceneIndex, stopSceneIndex,
} from './media.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const notFound = (what) => new HttpError(404, `${what} not found`);

// ----------------------------------------------------------------------- auth

const ownerOf = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
const keyOwners = new Map(config.apiKeys.map((key) => [key, ownerOf(key)]));

/** Resolves an API key or a client session token to its owner. */
export function authenticate(token) {
  if (!token) return null;
  for (const [key, owner] of keyOwners) {
    if (key.length === token.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(token))) return owner;
  }
  const row = one('SELECT owner, expires_at FROM tokens WHERE token = ?', token);
  return row && row.expires_at > now() ? row.owner : null;
}

function tokenFrom(req, url) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return req.headers['x-access-token'] || (bearer && bearer[1]) || url.searchParams.get('token');
}

const sign = (value) => crypto.createHmac('sha256', config.secret).update(value).digest('hex').slice(0, 32);
const signed = (value, signature) =>
  typeof signature === 'string' && signature.length === 32 &&
  crypto.timingSafeEqual(Buffer.from(sign(value)), Buffer.from(signature));

// -------------------------------------------------------------- serialisation

const collectionJson = (c) => ({
  id: c.id, name: c.name, description: c.description, is_public: Boolean(c.is_public), owner: c.owner,
});

const rtstreamJson = (r) => ({
  rtstream_id: r.id, id: r.id, name: r.name, channel_id: r.channel_id, collection_id: r.collection_id,
  status: r.status, media_types: [r.media_type], created_at: r.created_at,
  sample_rate: r.media_type === 'audio' ? 48000 : undefined,
});

function sessionJson(s) {
  const streams = all('SELECT * FROM rtstreams WHERE session_id = ? ORDER BY created_at, rowid', s.id);
  return {
    id: s.id, session_id: s.id, collection_id: s.collection_id, status: s.status,
    end_user_id: s.end_user_id, callback_url: s.callback_url || undefined,
    metadata: JSON.parse(s.metadata || '{}'), created_at: s.created_at,
    exported_video_id: s.exported_video_id || undefined, export_status: s.export_status || undefined,
    primary_video_channel_id: s.primary_video_channel_id || undefined,
    channels: streams.map((r) => ({ channel_id: r.channel_id, name: r.name, type: r.media_type, store: Boolean(r.store) })),
    rtstreams: streams.map(rtstreamJson),
  };
}

function videoJson(v) {
  const k = sign(v.id);
  return {
    id: v.id, collection_id: v.collection_id, name: v.name, description: v.description,
    length: String(v.length ?? 0), size: v.size, user_id: v.owner,
    stream_url: `${config.publicUrl}/media/${v.id}.mp4?k=${k}`,
    player_url: `${config.publicUrl}/watch?v=${v.id}&k=${k}`,
    thumbnail_url: null,
  };
}

const sceneIndexJson = (i) => ({
  rtstream_index_id: i.id, rtstream_id: i.rtstream_id, name: i.name, prompt: i.prompt, status: i.status,
  extraction_type: i.extraction_type, extraction_config: JSON.parse(i.extraction_config || '{}'),
});

// ------------------------------------------------------------- session control

function sessionEvent(session, event, data = {}) {
  const message = { channel: 'capture_session', event, capture_session_id: session.id, status: session.status, data };
  if (!sendTo(session.ws_connection_id, message)) broadcast(session.owner, message);
}

export async function finishSession(sessionId) {
  const session = one('SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!session || ['stopping', 'stopped', 'exported'].includes(session.status)) return session;
  run("UPDATE sessions SET status = 'stopping' WHERE id = ?", sessionId);
  await stopSessionStreams(sessionId);
  run("UPDATE sessions SET status = 'stopped', stopped_at = ? WHERE id = ?", now(), sessionId);
  const stopped = one('SELECT * FROM sessions WHERE id = ?', sessionId);
  sessionEvent(stopped, 'capture_session.stopped');
  exportSession(sessionId); // deliberately not awaited: clients poll for exported_video_id
  return stopped;
}

/** Closes sessions whose publisher vanished without calling stop. */
export function reapAbandonedSessions() {
  const cutoff = Date.now() / 1000 - 120;
  for (const session of all("SELECT id, created_at FROM sessions WHERE status = 'active'")) {
    const live = one(
      `SELECT COUNT(*) AS n FROM segments s JOIN rtstreams r ON r.id = s.rtstream_id
       WHERE r.session_id = ? AND s.ended_at IS NULL`, session.id
    ).n;
    const last = one(
      `SELECT MAX(s.ended_at) AS t FROM segments s JOIN rtstreams r ON r.id = s.rtstream_id
       WHERE r.session_id = ?`, session.id
    ).t;
    const idleSince = last ?? session.created_at;
    if (!live && idleSince < (last ? cutoff : cutoff - 480)) {
      console.log(`[api] session ${session.id} has no publisher; closing it`);
      finishSession(session.id).catch((err) => console.error(err));
    }
  }
}

function ownedStream(owner, id) {
  const stream = one('SELECT * FROM rtstreams WHERE id = ? AND owner = ?', id, owner);
  if (!stream) throw notFound('RTStream');
  return stream;
}

function ownedVideo(owner, id) {
  const video = one('SELECT * FROM videos WHERE id = ? AND owner = ?', id, owner);
  if (!video) throw notFound('Video');
  return video;
}

function ownedSession(owner, id) {
  const session = one('SELECT * FROM sessions WHERE id = ? AND owner = ?', id, owner);
  if (!session) throw notFound('Capture session');
  return session;
}

/** Transcript of an exported video, timed from the start of the recording. */
function videoTranscript(video) {
  if (!video.session_id) return [];
  const origin = one(
    `SELECT MIN(s.started_at) AS t FROM segments s JOIN rtstreams r ON r.id = s.rtstream_id
     WHERE r.session_id = ?`, video.session_id
  ).t;
  return all(
    `SELECT t.start, t.end, t.text, r.channel_id FROM transcripts t
     JOIN rtstreams r ON r.id = t.rtstream_id WHERE t.session_id = ? ORDER BY t.start`, video.session_id
  ).map((row) => ({
    start: Math.max(0, row.start - (origin ?? row.start)),
    end: Math.max(0, row.end - (origin ?? row.start)),
    text: row.text,
    speaker: row.channel_id?.startsWith('mic') ? 'me' : 'them',
  }));
}

// --------------------------------------------------------------------- routes

/** [method, pattern, handler(ctx)] — `:name` segments become ctx.params. */
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });

route('GET', '/collection', ({ owner }) => {
  defaultCollection(owner);
  return { collections: all('SELECT * FROM collections WHERE owner = ? ORDER BY created_at', owner).map(collectionJson) };
});

route('POST', '/collection', ({ owner, body }) => {
  const id = newId('c');
  run(
    'INSERT INTO collections (id, owner, name, description, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, owner, body.name || 'Untitled', body.description || '', body.is_public ? 1 : 0, now()
  );
  return collectionJson(one('SELECT * FROM collections WHERE id = ?', id));
});

route('GET', '/collection/:cid', ({ collection }) => collectionJson(collection));

route('GET', '/collection/:cid/websocket', ({ owner }) => {
  const ticket = 'ws-' + crypto.randomBytes(24).toString('base64url');
  run('INSERT INTO tokens (token, owner, expires_at) VALUES (?, ?, ?)', ticket, owner, now() + 300);
  return { websocket_url: `${config.publicWsUrl}/ws?token=${ticket}` };
});

route('POST', '/capture/session/token', ({ owner, body }) => {
  const token = 'st-' + crypto.randomBytes(32).toString('base64url');
  const expiresIn = Math.min(Math.max(Number(body.expires_in) || 86400, 60), 7 * 86400);
  run('INSERT INTO tokens (token, owner, expires_at) VALUES (?, ?, ?)', token, owner, now() + expiresIn);
  return { token, expires_in: expiresIn };
});

route('POST', '/collection/:cid/capture/session', ({ owner, collection, body }) => {
  const id = newId('cap');
  run(
    `INSERT INTO sessions (id, owner, collection_id, end_user_id, status, metadata, callback_url, ws_connection_id, created_at)
     VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?)`,
    id, owner, collection.id, body.end_user_id || null, JSON.stringify(body.metadata || {}),
    body.callback_url || null, body.ws_connection_id || null, now()
  );
  return { session_id: id, id, collection_id: collection.id, end_user_id: body.end_user_id, status: 'created', created_at: now() };
});

route('GET', '/collection/:cid/capture/session', ({ owner, collection }) => ({
  sessions: all('SELECT * FROM sessions WHERE owner = ? AND collection_id = ? ORDER BY created_at DESC', owner, collection.id).map(sessionJson),
}));

route('GET', '/collection/:cid/capture/session/:sid', ({ owner, params }) => sessionJson(ownedSession(owner, params.sid)));

route('POST', '/collection/:cid/capture/session/:sid/export', ({ owner, params }) => {
  const session = ownedSession(owner, params.sid);
  if (session.status === 'stopped' && !session.exported_video_id) exportSession(session.id);
  return { session_id: session.id, export_status: session.export_status || 'pending', exported_video_id: session.exported_video_id || undefined };
});

// Called by the capture binary itself, authenticated with the session token.
route('POST', '/capture/session/start', ({ owner, body }) => {
  const session = ownedSession(owner, body.session_id);
  if (session.status !== 'created') throw new HttpError(409, `Capture session is ${session.status}`);
  if (!Array.isArray(body.channels) || !body.channels.length) throw new HttpError(400, 'channels are required');

  const channels = body.channels.map((channel) => {
    const channelId = channel.channel_id || channel.name || channel.channel_name;
    if (!channelId) throw new HttpError(400, 'each channel needs a channel_id');
    const id = newId('rts');
    const type = channel.type === 'video' ? 'video' : 'audio';
    const name = channelId.split(':')[0];
    run(
      `INSERT INTO rtstreams (id, owner, session_id, collection_id, channel_id, name, media_type, status, store, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'connecting', ?, ?, ?)`,
      id, owner, session.id, session.collection_id, channelId, name, type,
      channel.store === false ? 0 : 1, channel.is_primary ? 1 : 0, now()
    );
    startStream(one('SELECT * FROM rtstreams WHERE id = ?', id));
    return { channel_id: channelId, channel_name: channel.name || channelId, rtsp_url: `${config.rtspPublishUrl}/${id}`, stream_id: id };
  });

  const primary = body.primary_video_channel_id || body.channels.find((c) => c.is_primary && c.type === 'video')?.channel_id;
  run(
    "UPDATE sessions SET status = 'active', primary_video_channel_id = ?, ws_connection_id = COALESCE(?, ws_connection_id) WHERE id = ?",
    primary || null, body.ws_connection_id || null, session.id
  );
  sessionEvent({ ...session, status: 'active' }, 'capture_session.active');

  const data = { streaming_session_id: session.id, channels, status: 'active', created_at: session.created_at };
  if (config.sslCertificateHash) data.ssl_certificate_hash = config.sslCertificateHash;
  return data;
});

route('POST', '/capture/session/:sid/stop', async ({ owner, params }) => {
  ownedSession(owner, params.sid);
  const session = await finishSession(params.sid);
  return { session_id: session.id, status: session.status };
});

route('GET', '/capture/session/:sid', ({ owner, params }) => {
  const session = ownedSession(owner, params.sid);
  const data = {
    streaming_session_id: session.id, status: session.status, created_at: session.created_at,
    channels: all('SELECT * FROM rtstreams WHERE session_id = ?', session.id).map((r) => ({
      channel_id: r.channel_id, channel_name: r.name, rtsp_url: `${config.rtspPublishUrl}/${r.id}`, stream_id: r.id,
    })),
  };
  if (config.sslCertificateHash) data.ssl_certificate_hash = config.sslCertificateHash;
  return data;
});

route('GET', '/rtstream/:rid', ({ owner, params }) => rtstreamJson(ownedStream(owner, params.rid)));

route('POST', '/rtstream/:rid/transcription', ({ owner, params, body }) => {
  const stream = ownedStream(owner, params.rid);
  const enabled = body.action !== 'stop';
  setTranscription(stream.id, enabled
    ? { enabled, wsConnectionId: body.ws_connection_id || null, languageCode: body.language_code || null }
    : { enabled });
  return { rtstream_id: stream.id, status: enabled ? 'started' : 'stopped', engine: body.engine || 'whisper' };
});

route('GET', '/rtstream/:rid/transcription', ({ owner, params, query }) => {
  const stream = ownedStream(owner, params.rid);
  const page = Math.max(1, Number(query.get('page')) || 1);
  const size = Math.min(1000, Number(query.get('page_size')) || 100);
  const since = Number(query.get('since') || query.get('start')) || 0;
  const rows = all(
    'SELECT start, end, text FROM transcripts WHERE rtstream_id = ? AND end >= ? ORDER BY start LIMIT ? OFFSET ?',
    stream.id, since, size + 1, (page - 1) * size
  );
  return {
    segments: rows.slice(0, size).map((row) => ({ ...row, is_final: true })),
    next_page: rows.length > size,
  };
});

route('POST', '/rtstream/:rid/index/scene', ({ owner, params, body }) => {
  const stream = ownedStream(owner, params.rid);
  const id = newId('rtsidx');
  run(
    `INSERT INTO scene_indexes (id, rtstream_id, name, prompt, extraction_type, extraction_config, model_name, ws_connection_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)`,
    id, stream.id, body.name || null, body.prompt || null, body.extraction_type || 'time_based',
    JSON.stringify(body.extraction_config || {}), body.model_name || null, body.ws_connection_id || null, now()
  );
  startSceneIndex(id);
  return sceneIndexJson(one('SELECT * FROM scene_indexes WHERE id = ?', id));
});

route('GET', '/rtstream/:rid/index/scene', ({ owner, params }) => ({
  scene_indexes: all('SELECT * FROM scene_indexes WHERE rtstream_id = ? ORDER BY created_at', ownedStream(owner, params.rid).id).map(sceneIndexJson),
}));

route('GET', '/rtstream/:rid/index/scene/:iid', ({ owner, params, query }) => {
  ownedStream(owner, params.rid);
  const page = Math.max(1, Number(query.get('page')) || 1);
  const size = Math.min(1000, Number(query.get('page_size')) || 100);
  const rows = all(
    'SELECT start, end, text AS description FROM scenes WHERE scene_index_id = ? ORDER BY start LIMIT ? OFFSET ?',
    params.iid, size + 1, (page - 1) * size
  );
  return { scene_index_records: rows.slice(0, size), next_page: rows.length > size };
});

route('PATCH', '/rtstream/:rid/index/scene/:iid/status', ({ owner, params, body }) => {
  ownedStream(owner, params.rid);
  if (!one('SELECT id FROM scene_indexes WHERE id = ? AND rtstream_id = ?', params.iid, params.rid)) throw notFound('Scene index');
  if (body.action === 'stop') stopSceneIndex(params.iid);
  else startSceneIndex(params.iid);
  return sceneIndexJson(one('SELECT * FROM scene_indexes WHERE id = ?', params.iid));
});

route('GET', '/video', ({ owner, query }) => {
  const collection = getCollection(owner, query.get('collection_id'));
  if (!collection) throw notFound('Collection');
  return { videos: all('SELECT * FROM videos WHERE owner = ? AND collection_id = ? ORDER BY created_at DESC', owner, collection.id).map(videoJson) };
});

route('GET', '/video/:vid', ({ owner, params }) => videoJson(ownedVideo(owner, params.vid)));

route('DELETE', '/video/:vid', ({ owner, params }) => {
  const video = ownedVideo(owner, params.vid);
  fs.rmSync(path.join(MEDIA_DIR, video.file), { force: true });
  run('DELETE FROM videos WHERE id = ?', video.id);
  return {};
});

// Recordings are transcribed live, so there is nothing left to index afterwards.
route('POST', '/video/:vid/index', ({ owner, params }) => {
  ownedVideo(owner, params.vid);
  return { success: true, message: 'Spoken words are indexed during capture' };
});

route('GET', '/video/:vid/transcription', ({ owner, params }) => {
  const words = videoTranscript(ownedVideo(owner, params.vid));
  return { text: words.map((word) => word.text).join(' '), word_timestamps: words };
});

route('POST', '/download', ({ body }) => ({
  download_url: body.stream_link, name: body.name || 'recording',
}));

route('POST', '/collection/:cid/generate/text', async ({ body }) => {
  const output = await complete([{ role: 'user', content: body.prompt || '' }], {
    model: body.model_name || 'basic',
    json: body.response_type === 'json',
    maxTokens: body.max_tokens,
    temperature: body.temperature,
  });
  return { output: body.response_type === 'json' ? JSON.parse(output) : output };
});

// --------------------------------------------------------------------- server

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

/** OpenAI-compatible passthrough; Call.md points the OpenAI SDK at this server. */
async function chatCompletions(req, res) {
  const fail = (status, message) => send(res, status, { error: { message, type: 'invalid_request_error' } });
  if (!llmConfigured()) return fail(503, 'No LLM is configured on this server (see LLM_PROVIDER / LLM_BASE_URL)');
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return fail(err.status || 400, err.message);
  }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const upstream = await forwardChatCompletion(body, abort.signal);
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-cache',
    });
    if (upstream.body) Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
    else res.end();
  } catch (err) {
    if (!res.headersSent) fail(502, `LLM upstream unreachable: ${err.message}`);
    else res.end();
  }
}

function serveMedia(req, res, url) {
  const match = /^\/media\/(m-[0-9a-f-]+)\.mp4$/.exec(url.pathname);
  if (!match || !signed(match[1], url.searchParams.get('k'))) return send(res, 404, { success: false, message: 'Not found' });
  const video = one('SELECT file, name FROM videos WHERE id = ?', match[1]);
  const file = video && path.join(MEDIA_DIR, video.file);
  if (!file || !fs.existsSync(file)) return send(res, 404, { success: false, message: 'Not found' });

  const { size } = fs.statSync(file);
  const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  if (url.searchParams.has('download')) {
    headers['content-disposition'] = `attachment; filename="${(video.name || match[1]).replace(/[^\w .-]/g, '_')}.mp4"`;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': size });
    return fs.createReadStream(file).pipe(res);
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
  fs.createReadStream(file, { start, end }).pipe(res);
}

function servePlayer(res, url) {
  const id = url.searchParams.get('v') || '';
  const k = url.searchParams.get('k') || '';
  const video = signed(id, k) && one('SELECT name FROM videos WHERE id = ?', id);
  if (!video) return send(res, 404, { success: false, message: 'Not found' });
  const title = String(video.name || 'Recording').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;object-fit:contain}</style></head>
<body><video controls playsinline preload="metadata" src="/media/${id}.mp4?k=${k}"></video></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-headers': 'content-type, authorization, x-access-token',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    });
    return res.end();
  }
  if (pathname === '/health' || pathname === '/') return send(res, 200, { success: true, data: { status: 'ok', service: 'meeting-md-server' } });
  if (pathname.startsWith('/media/')) return serveMedia(req, res, url);
  if (pathname === '/watch' || pathname === '/embed') return servePlayer(res, url);

  const owner = authenticate(tokenFrom(req, url));
  if (!owner) return send(res, 401, { success: false, message: 'Invalid or missing API key' });

  if (req.method === 'POST' && /^(\/v1)?\/chat\/completions$/.test(pathname)) return chatCompletions(req, res);

  const parts = pathname.split('/').filter(Boolean);
  for (const candidate of routes) {
    if (candidate.method !== req.method || candidate.parts.length !== parts.length) continue;
    const params = {};
    const matches = candidate.parts.every((part, i) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(parts[i]);
        return true;
      }
      return part === parts[i];
    });
    if (!matches) continue;

    try {
      const ctx = { owner, params, query: url.searchParams, body: req.method === 'GET' ? {} : await readJson(req) };
      if (params.cid) {
        ctx.collection = getCollection(owner, params.cid);
        if (!ctx.collection) throw notFound('Collection');
      }
      return send(res, 200, { success: true, data: await candidate.handler(ctx) });
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(`[api] ${req.method} ${pathname}:`, err);
      return send(res, err.status || 500, { success: false, message: err.message });
    }
  }
  send(res, 404, { success: false, message: `No route for ${req.method} ${pathname}` });
}
