import { config } from './config.js';
import { errorResponse } from './providers/openai-format.js';
import * as anthropicProvider from './providers/anthropic.js';
import * as claudeCodeProvider from './providers/claude-code.js';

const { provider } = config.llm;

/**
 * Call.md sends VideoDB's tier names ('basic' | 'pro' | 'ultra') as the model.
 * Map those onto the configured models; any other name passes through.
 */
export function resolveModel(name) {
  if (name in config.llm.models) return config.llm.models[name];
  return name || config.llm.models.ultra;
}

export function llmConfigured() {
  if (provider === 'anthropic' || provider === 'claude-code') return true;
  return Boolean(config.llm.baseUrl);
}

export function llmDescription() {
  if (!llmConfigured()) return 'NOT CONFIGURED';
  const model = config.llm.models.ultra || '(provider default model)';
  if (provider === 'claude-code') return `Claude Code CLI (${config.llm.claudeCode.path}), ${model}`;
  if (provider === 'anthropic') return `Anthropic API, ${model}`;
  return `${provider} ${config.llm.baseUrl}, ${model}`;
}

function openAiCompatible(body, model, signal) {
  const headers = { 'content-type': 'application/json' };
  if (config.llm.apiKey) headers.authorization = `Bearer ${config.llm.apiKey}`;
  if (provider === 'openrouter') {
    // Optional attribution headers OpenRouter shows on its dashboard.
    headers['X-Title'] = process.env.OPENROUTER_APP_TITLE || 'meeting.md';
    if (process.env.OPENROUTER_APP_URL) headers['HTTP-Referer'] = process.env.OPENROUTER_APP_URL;
  }
  if (!model) return errorResponse(503, 'No model configured: set LLM_MODEL on the server');
  return fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, model }),
    signal,
  });
}

/**
 * Runs an OpenAI-format chat completion on the configured provider and returns
 * an OpenAI-format `Response` (JSON, or SSE when `body.stream` is set).
 */
export async function forwardChatCompletion(body, signal) {
  const model = resolveModel(body.model);
  if (provider === 'anthropic') return anthropicProvider.chatCompletion(body, model, signal);
  if (provider === 'claude-code') return claudeCodeProvider.chatCompletion(body, model, signal);
  return openAiCompatible(body, model, signal);
}

export async function complete(messages, { model = 'ultra', json = false, maxTokens, temperature } = {}) {
  if (!llmConfigured()) throw new Error('No LLM is configured on this server');
  const body = { model, messages };
  if (json) body.response_format = { type: 'json_object' };
  if (maxTokens) body.max_tokens = maxTokens;
  if (temperature !== undefined) body.temperature = temperature;

  const res = await forwardChatCompletion(body, AbortSignal.timeout(180000));
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM upstream ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).choices?.[0]?.message?.content ?? '';
}

/** Describes one JPEG frame with the configured vision model. */
export function describeImage(jpeg, prompt) {
  return complete(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
        ],
      },
    ],
    { model: config.llm.visionModel || 'ultra', maxTokens: 400 }
  );
}
