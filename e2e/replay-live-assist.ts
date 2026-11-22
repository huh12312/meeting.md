/**
 * Replays a recorded meeting transcript through Live Assist, using the app's
 * own prompt and de-duplication code, to see what suggestions it would show.
 *
 *   cd app && npx tsx ../e2e/replay-live-assist.ts <server data dir> [context.json]
 *
 * Needs the server running (API_URL, API_KEY). context.json may hold
 * { name, description, checklist } as the meeting-setup wizard would.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LIVE_ASSIST_SYSTEM_PROMPT,
  buildAlreadySuggestedSection,
  filterNewSuggestions,
  rememberSuggestions,
} from '../app/src/main/lib/live-assist-prompt';

const [dataDir, contextFile] = process.argv.slice(2);
const apiUrl = process.env.API_URL || 'http://localhost:8080';
const apiKey = process.env.API_KEY || '';
const WINDOW_SECONDS = 20;

const db = new DatabaseSync(path.join(dataDir, 'meeting-md.db'), { readOnly: true });
const rows = db
  .prepare(
    `SELECT t.start, t.end, t.text, r.channel_id FROM transcripts t
     JOIN rtstreams r ON r.id = t.rtstream_id ORDER BY t.end`
  )
  .all() as Array<{ start: number; end: number; text: string; channel_id: string }>;
if (rows.length === 0) throw new Error('no transcripts in that data directory');

const context = contextFile ? JSON.parse(fs.readFileSync(contextFile, 'utf8')) : null;
const contextSection = context
  ? `## MEETING CONTEXT\nMeeting: ${context.name}\n\nPurpose: ${context.description}\n\nGoals to cover:\n${(context.checklist || [])
      .map((item: string) => `- ${item}`)
      .join('\n')}\n\n---\n\n`
  : '';

let say: string[] = [];
let ask: string[] = [];
const shown: Array<{ at: number; kind: string; text: string }> = [];
let calls = 0;
let empty = 0;

async function main(): Promise<void> {
  const origin = rows[0].start;
  const lastEnd = rows[rows.length - 1].end;
  for (let from = origin; from < lastEnd; from += WINDOW_SECONDS) {
    // A segment reaches the app when it has been transcribed, i.e. after it ends.
    const chunk = rows.filter((row) => row.end >= from && row.end < from + WINDOW_SECONDS);
    if (chunk.length === 0) continue;
    const transcript = chunk
      .map((row) => `[${row.channel_id.startsWith('mic') ? 'User' : 'Them'}]: ${row.text}`)
      .join('\n');
    const user = `${contextSection}${buildAlreadySuggestedSection(say, ask)}## TRANSCRIPT\n${transcript}`;

    const res = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'ultra',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: LIVE_ASSIST_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
    });
    calls++;
    const content: string = (await res.json()).choices?.[0]?.message?.content || '';
    let data: { say_this?: unknown; ask_this?: unknown } = {};
    try {
      data = JSON.parse((/```(?:json)?\s*([\s\S]*?)```/.exec(content)?.[1] ?? content).trim());
    } catch {
      console.error(`unparseable answer at ${Math.round(from - origin)}s: ${content.slice(0, 120)}`);
      continue;
    }

    const newSay = filterNewSuggestions(data.say_this, say);
    const newAsk = filterNewSuggestions(data.ask_this, ask);
    say = rememberSuggestions(say, newSay);
    ask = rememberSuggestions(ask, newAsk);
    if (newSay.length + newAsk.length === 0) empty++;
    const at = Math.round(from - origin);
    for (const text of newSay) shown.push({ at, kind: 'say', text });
    for (const text of newAsk) shown.push({ at, kind: 'ask', text });
  }

  for (const item of shown) {
    const stamp = `${Math.floor(item.at / 60)}:${String(item.at % 60).padStart(2, '0')}`;
    console.log(`${stamp} ${item.kind}  ${item.text}`);
  }
  console.log(
    `\n${calls} calls, ${empty} with nothing new, ${shown.filter((s) => s.kind === 'say').length} say / ${
      shown.filter((s) => s.kind === 'ask').length
    } ask shown`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
