import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const trim = (u) => (u || '').replace(/\/+$/, '');

export const DATA_DIR = path.resolve(env.DATA_DIR || './data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });

function persisted(name, make) {
  const file = path.join(DATA_DIR, name);
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const value = make();
    fs.writeFileSync(file, value + '\n', { mode: 0o600 });
    return value;
  }
}

const port = Number(env.PORT || 8080);
const publicUrl = trim(env.PUBLIC_URL) || `http://localhost:${port}`;

// API keys: explicit list, or one generated on first boot and kept in DATA_DIR.
const explicitKeys = (env.API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
const generatedKey = explicitKeys.length
  ? null
  : persisted('api_key', () => 'sk-selfhost-' + crypto.randomBytes(24).toString('base64url'));

/**
 * SPKI pin for the RTSPS certificate. The stock capture binary refuses plain
 * RTSP to non-pinned hosts and pins the server key instead of walking a CA
 * chain, so a self-signed certificate is fine as long as we hand out its hash.
 */
function spkiHash(certPath) {
  if (!certPath) return null;
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
    const digest = crypto.createHash('sha256').update(spki);
    return (env.RTSP_TLS_HASH_FORMAT || 'base64') === 'hex' ? digest.digest('hex') : digest.digest('base64');
  } catch (err) {
    console.warn(`[config] could not read RTSP_TLS_CERT ${certPath}: ${err.message}`);
    return null;
  }
}

export const config = {
  port,
  host: env.HOST || '0.0.0.0',
  publicUrl,
  publicWsUrl: trim(env.PUBLIC_WS_URL) || publicUrl.replace(/^http/, 'ws'),
  apiKeys: explicitKeys.length ? explicitKeys : [generatedKey],
  generatedKey,
  secret: persisted('secret', () => crypto.randomBytes(32).toString('hex')),

  // Where capture clients publish, and where this server reads the same streams.
  rtspPublishUrl: trim(env.RTSP_PUBLISH_URL) || 'rtsp://localhost:8554',
  rtspInternalUrl: trim(env.RTSP_INTERNAL_URL) || trim(env.RTSP_PUBLISH_URL) || 'rtsp://localhost:8554',
  sslCertificateHash: env.RTSP_TLS_HASH || spkiHash(env.RTSP_TLS_CERT),

  llm: (() => {
    // openai      any OpenAI-compatible /chat/completions (Ollama, vLLM, OpenAI, ...)
    // openrouter  the same wire format, pointed at OpenRouter
    // anthropic   Claude through the Anthropic API
    // claude-code Claude through the Claude Code CLI's own login
    const provider = (env.LLM_PROVIDER || 'openai').toLowerCase();
    const fallbackModel = env.LLM_MODEL || (provider === 'anthropic' ? 'claude-opus-5-5' : '');
    return {
      provider,
      baseUrl: trim(env.LLM_BASE_URL) || (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : ''),
      apiKey: env.LLM_API_KEY || (provider === 'openrouter' ? env.OPENROUTER_API_KEY || '' : ''),
      models: {
        basic: env.LLM_MODEL_BASIC || fallbackModel,
        pro: env.LLM_MODEL_PRO || fallbackModel,
        ultra: env.LLM_MODEL_ULTRA || fallbackModel,
      },
      visionModel: env.LLM_MODEL_VISION || fallbackModel,
      // Anthropic: reasoning effort (low | medium | high | xhigh | max), "off" to omit.
      effort: env.LLM_EFFORT === 'off' ? '' : env.LLM_EFFORT || 'medium',
      // Anthropic: let the API retry a safety decline on a fallback model.
      refusalFallbacks: env.LLM_REFUSAL_FALLBACKS !== 'off',
      claudeCode: {
        path: env.CLAUDE_CODE_PATH || 'claude',
        effort: env.LLM_EFFORT && env.LLM_EFFORT !== 'off' ? env.LLM_EFFORT : '',
        concurrency: Math.max(1, Number(env.CLAUDE_CODE_CONCURRENCY) || 2),
        timeoutMs: Number(env.CLAUDE_CODE_TIMEOUT_MS) || 180000,
      },
    };
  })(),

  stt: {
    baseUrl: trim(env.STT_BASE_URL),
    apiKey: env.STT_API_KEY || '',
    model: env.STT_MODEL || 'whisper-1',
    // Vocabulary hint passed with every request (names, product terms).
    prompt: env.STT_PROMPT || '',
    // Voice-activity segmentation of the live PCM tap.
    silenceMs: Number(env.STT_SILENCE_MS || 700),
    minSegmentMs: Number(env.STT_MIN_SEGMENT_MS || 3000),
    maxSegmentMs: Number(env.STT_MAX_SEGMENT_MS || 15000),
    minSpeechMs: Number(env.STT_MIN_SPEECH_MS || 300),
    minRms: Number(env.STT_MIN_RMS || 250),
    lagWarnSeconds: Number(env.STT_LAG_WARN_SECONDS || 20),
  },

  // Per-stream source recordings are deleted once a session is exported.
  keepRawSegments: env.KEEP_RAW_SEGMENTS === '1',

  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: env.FFPROBE_PATH || 'ffprobe',
};
