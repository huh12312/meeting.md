import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { textOf, imagesOf, parseArguments, completionResponse, errorResponse } from './openai-format.js';

let client;
function anthropic() {
  // The SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL
  // itself; LLM_API_KEY is only a convenience for a single shared .env.
  client ||= new Anthropic(
    config.llm.apiKey && !process.env.ANTHROPIC_API_KEY ? { apiKey: config.llm.apiKey } : {}
  );
  return client;
}

// Models that take the server-side refusal fallback, and models that reject `effort`.
const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/;
const NO_EFFORT_MODELS = /haiku-4-5|sonnet-4-5|claude-3/;

/**
 * Chat completions are stateless, but Claude's thinking blocks must come back
 * unchanged with the tool results that follow them. OpenAI's message format has
 * nowhere to carry them, so keep each tool-calling assistant turn here, keyed by
 * its tool-call ids, and replay it verbatim when the caller sends it back.
 */
const assistantTurns = new Map();
const MAX_REMEMBERED_TURNS = 2000;
function remember(content) {
  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    assistantTurns.set(block.id, content);
    if (assistantTurns.size > MAX_REMEMBERED_TURNS) assistantTurns.delete(assistantTurns.keys().next().value);
  }
}

function userBlocks(content) {
  const blocks = imagesOf(content).map((image) => ({
    type: 'image',
    source: image.url
      ? { type: 'url', url: image.url }
      : { type: 'base64', media_type: image.mediaType, data: image.data },
  }));
  const text = textOf(content);
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

function assistantBlocks(message) {
  const calls = message.tool_calls || [];
  const remembered = calls.length && assistantTurns.get(calls[0].id);
  if (remembered) return remembered;
  const blocks = [];
  const text = textOf(message.content);
  if (text) blocks.push({ type: 'text', text });
  for (const call of calls) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
  }
  return blocks;
}

/** OpenAI chat-completions request -> Messages API parameters. */
export function toMessagesParams(body, model) {
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    // Same-role neighbours merge, which also keeps every tool result of one
    // assistant turn together in a single user message as the API requires.
    if (last && last.role === role && role === 'user') last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };

  for (const message of body.messages || []) {
    if (message.role === 'system' || message.role === 'developer') {
      system.push(textOf(message.content));
    } else if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: textOf(message.content) }]);
    } else if (message.role === 'assistant') {
      push('assistant', assistantBlocks(message));
    } else {
      push('user', userBlocks(message.content));
    }
  }

  const params = {
    model,
    // The caller's limit was sized for models that do not think; thinking
    // tokens count against max_tokens here, so never go below a workable floor.
    max_tokens: Math.max(Number(body.max_tokens || body.max_completion_tokens) || 0, 16000),
    messages,
  };

  const format = body.response_format;
  if (format?.type === 'json_schema' && format.json_schema?.schema) {
    params.output_config = { format: { type: 'json_schema', schema: format.json_schema.schema } };
  } else if (format?.type === 'json_object') {
    system.push('Respond with a single valid JSON object and nothing else: no prose, no code fences.');
  }
  if (config.llm.effort && !NO_EFFORT_MODELS.test(model)) {
    params.output_config = { ...params.output_config, effort: config.llm.effort };
  }
  if (system.filter(Boolean).length) params.system = system.filter(Boolean).join('\n\n');

  if (Array.isArray(body.tools) && body.tools.length) {
    params.tools = body.tools
      .filter((tool) => tool.type === 'function' && tool.function?.name)
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description || '',
        input_schema: tool.function.parameters || { type: 'object', properties: {} },
      }));
    // Forcing a call is rejected by current models; "auto" is the only on-mode.
    if (body.tool_choice === 'none') params.tool_choice = { type: 'none' };
  }
  // temperature / top_p are deliberately dropped: current models reject them.
  return params;
}

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'content_filter' };

/** Messages API response -> the fields of an OpenAI chat completion. */
export function fromMessage(message) {
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  const toolCalls = message.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }));
  const usage = message.usage || {};
  const prompt = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return {
    model: message.model,
    content: text,
    toolCalls,
    finishReason: FINISH[message.stop_reason] || 'stop',
    usage: { prompt_tokens: prompt, completion_tokens: usage.output_tokens || 0, total_tokens: prompt + (usage.output_tokens || 0) },
  };
}

export async function chatCompletion(body, model, signal) {
  const params = toMessagesParams(body, model);
  if (!params.messages.length) return errorResponse(400, 'messages must contain at least one non-system message', 'invalid_request_error');

  try {
    // Streamed and collected, so long answers are not cut off by HTTP timeouts.
    const useFallbacks = config.llm.refusalFallbacks && FALLBACK_MODELS.test(model);
    const stream = useFallbacks
      ? anthropic().beta.messages.stream(
          { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          { signal }
        )
      : anthropic().messages.stream(params, { signal });
    const message = await stream.finalMessage();

    if (message.stop_reason === 'tool_use') remember(message.content);
    if (message.stop_reason === 'refusal') {
      console.warn(`[llm] ${message.model} declined the request (${message.stop_details?.category ?? 'uncategorised'})`);
    }
    return completionResponse(fromMessage(message), body.stream);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      // Not passed through as 401/403: the app would read that as its own key being wrong.
      return errorResponse(502, `Anthropic rejected the server's credentials: ${error.message}`);
    }
    if (error instanceof Anthropic.BadRequestError) return errorResponse(400, error.message, 'invalid_request_error');
    if (error instanceof Anthropic.RateLimitError) return errorResponse(429, error.message, 'rate_limit_error');
    if (error instanceof Anthropic.APIConnectionError) return errorResponse(502, `Could not reach Anthropic: ${error.message}`);
    if (error instanceof Anthropic.APIError) return errorResponse(error.status || 502, error.message);
    throw error;
  }
}
