import { config } from './config.js';

export const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS * 2) / 1000; // s16le mono
const PRE_ROLL_FRAMES = 15; // 300 ms kept ahead of detected speech
const START_FRAMES = 3; // consecutive loud frames that open a segment

function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 2) {
    const s = frame.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / (frame.length / 2));
}

/**
 * Cuts a continuous 16 kHz mono PCM stream into utterances on pauses.
 *
 * Whisper-style endpoints are request/response, not streaming, so "real time"
 * here means: detect an utterance, send it, emit the final text. Latency is the
 * utterance length plus one transcription round trip.
 */
export class Segmenter {
  constructor(onSegment) {
    this.onSegment = onSegment;
    this.pending = Buffer.alloc(0);
    this.preRoll = [];
    this.frames = [];
    this.active = false;
    this.loud = 0;
    this.quietMs = 0;
    this.speechMs = 0;
    this.noise = config.stt.minRms;
    this.position = 0; // seconds of audio consumed
    this.segmentStart = 0;
  }

  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    while (this.pending.length - offset >= FRAME_BYTES) {
      this.frame(this.pending.subarray(offset, offset + FRAME_BYTES));
      offset += FRAME_BYTES;
    }
    this.pending = this.pending.subarray(offset);
  }

  frame(frame) {
    const level = rms(frame);
    const threshold = Math.max(config.stt.minRms, this.noise * 3);
    const speech = level > threshold;
    this.position += FRAME_MS / 1000;

    if (!this.active) {
      if (!speech) this.noise = this.noise * 0.95 + level * 0.05;
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      this.loud = speech ? this.loud + 1 : 0;
      if (this.loud >= START_FRAMES) {
        this.active = true;
        this.frames = this.preRoll;
        this.segmentStart = this.position - (this.frames.length * FRAME_MS) / 1000;
        this.preRoll = [];
        this.loud = 0;
        this.quietMs = 0;
        this.speechMs = START_FRAMES * FRAME_MS;
      }
      return;
    }

    this.frames.push(frame);
    if (speech) {
      this.quietMs = 0;
      this.speechMs += FRAME_MS;
    } else {
      this.quietMs += FRAME_MS;
    }
    const lengthMs = this.frames.length * FRAME_MS;
    // A pause only ends the utterance once there is enough audio to transcribe
    // well; a pause twice as long always does, so short replies still come out.
    const paused =
      this.quietMs >= config.stt.silenceMs &&
      (lengthMs >= config.stt.minSegmentMs || this.quietMs >= config.stt.silenceMs * 2);
    if (paused || lengthMs >= config.stt.maxSegmentMs) this.flush();
  }

  flush() {
    if (!this.active) return;
    const frames = this.frames;
    const speechMs = this.speechMs;
    const start = this.segmentStart;
    this.active = false;
    this.frames = [];
    this.quietMs = 0;
    this.speechMs = 0;
    if (speechMs >= config.stt.minSpeechMs) {
      this.onSegment({ pcm: Buffer.concat(frames), start, end: this.position });
    }
  }
}

export function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Whisper sometimes gets stuck and repeats a phrase until it runs out of room,
 * usually on a clip that ends mid-sentence. Collapse any run of words that
 * repeats back-to-back three or more times down to a single occurrence.
 */
export function collapseRepeats(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const key = (word) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const out = [];
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    // Longest phrases first, so a looping sentence is not mistaken for a looping word.
    for (let size = Math.min(20, Math.floor((words.length - i) / 3)); size >= 1 && !collapsed; size--) {
      const same = (offset) => {
        for (let k = 0; k < size; k++) {
          if (i + offset + k >= words.length || key(words[i + k]) !== key(words[i + offset + k])) return false;
        }
        return true;
      };
      let repeats = 1;
      while (same(repeats * size)) repeats++;
      if (repeats >= 3) {
        out.push(...words.slice(i, i + size));
        i += repeats * size;
        collapsed = true;
      }
    }
    if (!collapsed) out.push(words[i++]);
  }
  return out.join(' ');
}

export function sttConfigured() {
  return Boolean(config.stt.baseUrl);
}

/** Transcribes one utterance through an OpenAI-compatible /audio/transcriptions. */
export async function transcribe(pcm, languageCode) {
  const form = new FormData();
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'segment.wav');
  form.append('model', config.stt.model);
  form.append('response_format', 'json');
  if (config.stt.prompt) form.append('prompt', config.stt.prompt);
  // The endpoint takes ISO-639-1; the app sends BCP-47 such as "pt-BR".
  if (languageCode) form.append('language', languageCode.split('-')[0].toLowerCase());

  const headers = {};
  if (config.stt.apiKey) headers.authorization = `Bearer ${config.stt.apiKey}`;

  const res = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`STT upstream ${res.status}: ${body.slice(0, 300)}`);
  let text = body;
  try {
    text = JSON.parse(body).text || '';
  } catch {
    // Some servers answer in plain text.
  }
  return collapseRepeats(text.trim());
}
