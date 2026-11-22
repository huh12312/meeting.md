import crypto from 'node:crypto';

/**
 * Helpers for providers that are not OpenAI-compatible on the wire. Call.md
 * only speaks OpenAI chat completions, so those providers translate the request
 * in and answer with a `Response` shaped like an OpenAI one.
 */

/** Text of an OpenAI message `content` (string or content-part array). */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

/** Image parts of an OpenAI message as `{ mediaType, data }` or `{ url }`. */
export function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part.type === 'image_url' && part.image_url?.url)
    .map((part) => {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url);
      return match ? { mediaType: match[1], data: match[2] } : { url: part.image_url.url };
    });
}

export function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Builds the OpenAI-format HTTP response, as SSE when the caller asked to stream. */
export function completionResponse({ model, content, toolCalls, finishReason, usage }, stream) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const message = { role: 'assistant', content: content || null };
  if (toolCalls?.length) message.tool_calls = toolCalls;

  if (!stream) {
    return Response.json({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    });
  }

  // The upstream answer is already complete, so it goes out as a single delta.
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const delta = { ...message };
  if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => ({ index, ...call }));
  return new Response(chunk(delta, null) + chunk({}, finishReason) + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function errorResponse(status, message, type = 'upstream_error') {
  return Response.json({ error: { message, type } }, { status });
}
