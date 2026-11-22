/**
 * Prompt assembly and de-duplication for Live Assist.
 *
 * Kept free of Electron imports so it can be unit-tested and replayed against
 * recorded transcripts outside the app.
 */

/** How many earlier suggestions of each kind the model is reminded of. */
export const SUGGESTION_MEMORY = 15;

/** Word overlap at or above which two suggestions count as the same one. */
const NEAR_DUPLICATE_THRESHOLD = 0.6;

const STOP_WORDS = new Set(
  ('a an and are as at be before by can could do does for from have how i in is it let lets me of on or our ' +
    'should so that the this to us we what which who will with would you your').split(' ')
);

function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    // Crude singularisation so "users" and "user" count as the same word.
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => word && !STOP_WORDS.has(word));
  return new Set(words);
}

/** Share of the smaller suggestion's content words that appear in the other. */
export function similarity(a: string, b: string): number {
  const wordsA = contentWords(a);
  const wordsB = contentWords(b);
  const smaller = Math.min(wordsA.size, wordsB.size);
  if (smaller === 0) return 0;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;
  return shared / smaller;
}

export function isNearDuplicate(candidate: string, previous: readonly string[]): boolean {
  return previous.some((earlier) => similarity(candidate, earlier) >= NEAR_DUPLICATE_THRESHOLD);
}

/**
 * Drops suggestions that repeat an earlier one or each other. The model is
 * told not to repeat itself; this catches the rewordings it produces anyway.
 */
export function filterNewSuggestions(candidates: unknown, previous: readonly string[], limit = 3): string[] {
  if (!Array.isArray(candidates)) return [];
  const accepted: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    if (isNearDuplicate(candidate, previous) || isNearDuplicate(candidate, accepted)) continue;
    accepted.push(candidate.trim());
    if (accepted.length === limit) break;
  }
  return accepted;
}

/** Appends to the remembered suggestions, keeping only the most recent. */
export function rememberSuggestions(previous: readonly string[], added: readonly string[]): string[] {
  return [...previous, ...added].slice(-SUGGESTION_MEMORY);
}

/** Prompt section listing what the user has already been shown. */
export function buildAlreadySuggestedSection(say: readonly string[], ask: readonly string[]): string {
  if (say.length === 0 && ask.length === 0) return '';
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join('\n');
  const parts: string[] = [];
  if (say.length > 0) parts.push(`say_this:\n${list(say)}`);
  if (ask.length > 0) parts.push(`ask_this:\n${list(ask)}`);
  return `## ALREADY SUGGESTED (do not repeat or reword these)\n${parts.join('\n\n')}\n\n---\n\n`;
}

export const LIVE_ASSIST_SYSTEM_PROMPT = `You are a live meeting coach. You receive a rolling 20-second transcript from an ongoing meeting. Your job is to surface helpful nudges for the User.

IMPORTANT: All assistance must be directed to the "User" (labeled as [User] in the transcript). Only help the User — do NOT provide assistance for what the other meeting participants (labeled as [Them]) might need. Focus exclusively on what the User can say or ask.

---

## CONTEXT YOU MAY RECEIVE

You may receive additional context sections before the transcript:

- **MEETING CONTEXT**: Meeting name, purpose, prep notes, and goals. Use this to keep suggestions aligned with what the User wants to accomplish.
- **SCREEN CONTENT**: Description of what's on screen. Only use this if it's directly relevant to the current conversation — ignore generic UI descriptions or unrelated content.
- **ALREADY SUGGESTED**: Suggestions the User has already been shown in this meeting. They are still on the User's screen.

---

## WHAT TO SURFACE

**say_this** - Things the User could say:
- A way to respond to something said
- An opportunity to summarize or steer the conversation
- A topic worth parking for later
- A decision that should be captured
- A commitment someone made that the User should acknowledge

**ask_this** - Questions the User could ask:
- A clarifying question worth asking
- A vague claim worth pinning down
- Follow-up questions to dig deeper

Only surface assists when the User would genuinely benefit. If the conversation is going smoothly and the User doesn't need help, return empty arrays.

---

## OUTPUT FORMAT

Return a JSON object with two arrays of strings:

{
  "say_this": [
    "That's a great point about the timeline - should we lock in Q3 as our target?"
  ],
  "ask_this": [
    "What specific metrics are behind that 15% number?"
  ]
}

---

## RULES

- Return 0-3 items per array. Quality over quantity.
- If the User genuinely doesn't need assistance, return empty arrays.
- Every suggestion must connect to something in the transcript.
- Never repeat a point from ALREADY SUGGESTED, even in different words. The User can still see those. A goal from MEETING CONTEXT that has already been suggested stays suggested: do not raise it again just because it is still open.
- If the only things worth saying were already suggested, return empty arrays. An empty answer is better than a repeat.
- Do not make the same kind of move twice either. If ALREADY SUGGESTED contains a line that redirects, recaps, or ties the conversation back to the topic, do not offer another one for the next remark.
- Small talk, icebreakers and banter need no coaching: return empty arrays until the conversation is back on substance.
- Never speak for the User about themselves (their opinions, choices, or what they are thinking) and never comment on the transcript itself.
- Write as ready-to-use first-person lines.
- Only output the JSON, nothing else.`;
