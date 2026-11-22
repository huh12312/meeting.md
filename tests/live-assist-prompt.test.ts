import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUGGESTION_MEMORY,
  buildAlreadySuggestedSection,
  filterNewSuggestions,
  isNearDuplicate,
  rememberSuggestions,
} from '../src/main/lib/live-assist-prompt';

const shown = [
  "Before we brainstorm, let's agree on one target audience for this remote so our ideas stay focused.",
  'Is the €50 million a revenue or a profit goal, and over what time period?',
];

test('reworded versions of an earlier suggestion are treated as duplicates', () => {
  assert.equal(
    isNearDuplicate("Before we jump into ideas, let's agree on one target audience for this remote so we're all focused.", shown),
    true
  );
  assert.equal(isNearDuplicate('Is the €50 million target revenue or profit, and over what period?', shown), true);
});

test('a suggestion on a different point is kept', () => {
  assert.equal(isNearDuplicate('Does the €12.50 cap include marketing and distribution?', shown), false);
  assert.equal(isNearDuplicate("Let's park the DVD zones idea and come back to it later.", shown), false);
});

test('filterNewSuggestions drops repeats, duplicates within a batch, and non-strings', () => {
  const result = filterNewSuggestions(
    [
      "Let's agree on one target audience for this remote before we brainstorm ideas.",
      'Which international markets are we targeting first?',
      'Which international markets are we targeting first, realistically?',
      '',
      42,
      'Who owns the budget follow-up?',
    ],
    shown
  );
  assert.deepEqual(result, ['Which international markets are we targeting first?', 'Who owns the budget follow-up?']);
  assert.deepEqual(filterNewSuggestions(undefined, shown), []);
  assert.equal(filterNewSuggestions(['a b c', 'd e f', 'g h i', 'j k l'], []).length, 3);
});

test('memory keeps only the most recent suggestions', () => {
  const many = Array.from({ length: SUGGESTION_MEMORY + 5 }, (_, i) => `suggestion ${i}`);
  const kept = rememberSuggestions([], many);
  assert.equal(kept.length, SUGGESTION_MEMORY);
  assert.equal(kept[kept.length - 1], `suggestion ${SUGGESTION_MEMORY + 4}`);
});

test('the already-suggested section appears only when there is something to list', () => {
  assert.equal(buildAlreadySuggestedSection([], []), '');
  const section = buildAlreadySuggestedSection(['Say A'], ['Ask B?']);
  assert.match(section, /## ALREADY SUGGESTED/);
  assert.match(section, /say_this:\n- Say A/);
  assert.match(section, /ask_this:\n- Ask B\?/);
});
