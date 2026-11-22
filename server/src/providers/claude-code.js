import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config, DATA_DIR } from '../config.js';
import { textOf, imagesOf, completionResponse, errorResponse } from './openai-format.js';

/**
 * Runs each completion through the Claude Code CLI in headless mode
 * (`claude -p`), authenticated with ANTHROPIC_API_KEY. With a key present the
 * CLI runs in bare mode, which Anthropic recommends for scripted use and which
 * never reads a stored login.
 *
 * Anthropic's terms do not allow an application to route its requests through
 * a Free/Pro/Max subscription login, so that is not a supported way to run this.
 *
 * The CLI is an agent, not a completions endpoint, so it is boxed in: built-in
 * tools and MCP servers off, nothing persisted, an empty working directory, and
 * a replaced system prompt. Tool calls the app asks for are not executed here;
 * they are returned to the app through a JSON schema, as with any other provider.
 */

const WORKDIR = path.join(DATA_DIR, 'claude-code');
fs.mkdirSync(WORKDIR, { recursive: true });

let running = 0;
const waiting = [];
async function slot() {
  if (running >= config.llm.claudeCode.concurrency) await new Promise((resolve) => waiting.push(resolve));
  running++;
  return () => {
    running--;
    waiting.shift()?.();
  };
}

const toolProtocol = (tools) => `
You can ask the caller to run tools. You cannot run them yourself. Available tools:
${tools.map((tool) => `- ${tool.function.name}: ${tool.function.description || ''}\n  arguments schema: ${JSON.stringify(tool.function.parameters || {})}`).join('\n')}

Answer with a JSON object {"content": string, "tool_calls": array}. To use tools, list each call in
"tool_calls" as {"name", "arguments"} and leave "content" empty; the caller runs them and sends the
results in the next turn. When no tool is needed, put your answer in "content" and leave "tool_calls" empty.`;

const toolSchema = (tools) => ({
  type: 'object',
  properties: {
    content: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string', enum: tools.map((tool) => tool.function.name) }, arguments: { type: 'object' } },
        required: ['name', 'arguments'],
      },
    },
  },
  required: ['content', 'tool_calls'],
});

/** OpenAI chat-completions request -> system prompt, one user turn, optional schema. */
export function toPrompt(body) {
  const system = [];
  const turns = [];
  const images = [];
  for (const message of body.messages || []) {
    const text = textOf(message.content);
    if (message.role === 'system' || message.role === 'developer') {
      system.push(text);
    } else if (message.role === 'tool') {
      turns.push({ label: `tool result (${message.tool_call_id})`, text });
    } else if (message.role === 'assistant') {
      const calls = (message.tool_calls || []).map((call) => `[called ${call.function.name} (${call.id}) with ${call.function.arguments}]`);
      turns.push({ label: 'assistant', text: [text, ...calls].filter(Boolean).join('\n') });
    } else {
      images.push(...imagesOf(message.content));
      turns.push({ label: 'user', text });
    }
  }

  const tools = (body.tools || []).filter((tool) => tool.type === 'function' && tool.function?.name);
  const useTools = tools.length > 0 && body.tool_choice !== 'none';
  let schema = null;
  if (useTools) {
    system.push(toolProtocol(tools));
    schema = toolSchema(tools);
  } else if (body.response_format?.type === 'json_schema' && body.response_format.json_schema?.schema) {
    schema = body.response_format.json_schema.schema;
  } else if (body.response_format?.type === 'json_object') {
    system.push('Respond with a single valid JSON object and nothing else: no prose, no code fences.');
  }

  // A lone user message goes through as-is; anything longer is replayed as a transcript.
  const text =
    turns.length === 1 && turns[0].label === 'user'
      ? turns[0].text
      : `${turns.map((turn) => `<${turn.label}>\n${turn.text}\n</${turn.label}>`).join('\n')}\n\nWrite the assistant's next reply to the conversation above.`;

  const content = images.map((image) => ({
    type: 'image',
    source: image.url ? { type: 'url', url: image.url } : { type: 'base64', media_type: image.mediaType, data: image.data },
  }));
  content.push({ type: 'text', text: text || '(empty message)' });

  return {
    system: system.filter(Boolean).join('\n\n') || 'You are a helpful assistant.',
    content,
    schema,
    useTools,
  };
}

function runCli(args, input, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.llm.claudeCode.path, args, { cwd: WORKDIR, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), config.llm.claudeCode.timeoutMs);
    const abort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });

    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`Claude Code CLI not found at "${config.llm.claudeCode.path}"`) : err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const result = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((event) => event?.type === 'result');
      if (result) resolve(result);
      else reject(new Error(stderr.trim() || `claude exited with code ${code} and no result`));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}

export async function chatCompletion(body, model, signal) {
  const { system, content, schema, useTools } = toPrompt(body);
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--system-prompt', system,
  ];
  if (process.env.ANTHROPIC_API_KEY) args.push('--bare');
  if (model) args.push('--model', model);
  if (config.llm.claudeCode.effort) args.push('--effort', config.llm.claudeCode.effort);
  if (schema) args.push('--json-schema', JSON.stringify(schema));

  const release = await slot();
  let result;
  try {
    result = await runCli(args, JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n', signal);
  } catch (err) {
    return errorResponse(502, `Claude Code: ${err.message}`);
  } finally {
    release();
  }
  if (result.is_error) return errorResponse(502, `Claude Code: ${String(result.result || result.subtype).slice(0, 500)}`);

  const usage = result.usage || {};
  const prompt = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const completion = {
    model: Object.keys(result.modelUsage || {})[0] || model || 'claude-code',
    content: typeof result.result === 'string' ? result.result : '',
    toolCalls: [],
    finishReason: 'stop',
    usage: { prompt_tokens: prompt, completion_tokens: usage.output_tokens || 0, total_tokens: prompt + (usage.output_tokens || 0) },
  };

  if (useTools) {
    const structured = result.structured_output || {};
    completion.content = structured.content || '';
    completion.toolCalls = (structured.tool_calls || []).map((call) => ({
      id: `call_${crypto.randomUUID().replace(/-/g, '')}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }));
    if (completion.toolCalls.length) completion.finishReason = 'tool_calls';
  } else if (schema && result.structured_output) {
    completion.content = JSON.stringify(result.structured_output);
  }
  return completionResponse(completion, body.stream);
}
