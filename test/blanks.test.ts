import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { blankContext, fillBlanks, findBlanks } from '../src/core/blanks';
import { kickoffPrompt } from '../src/core/transcript';

const PROMPT =
  "Read PLAN.md (Round 3). Version 0.3.2 is installed. My third look: <looks fine / what's wrong>. Check the log first (`logs/<window>/board.log`, newest window). If fine: push main with `git push <remote> main`, then report the link.";

test('findBlanks finds the slot left for the reply, and splits its choices', () => {
  const b = findBlanks(PROMPT);
  assert.equal(b.length, 1);
  assert.equal(b[0].text, "looks fine / what's wrong");
  assert.equal(PROMPT.slice(b[0].start, b[0].end), "<looks fine / what's wrong>");
  assert.deepEqual(b[0].choices, [
    { label: 'looks fine', open: false },
    { label: "what's wrong", open: true },
  ]);
});

test('findBlanks leaves code, commands, tags and comparisons alone', () => {
  assert.deepEqual(findBlanks('Run `npm run ship -- <id one>` then `<two words>`.'), [], 'inside backticks is code');
  assert.deepEqual(findBlanks('Ship <id1> <id2>, the branch <type>/<slug>.'), [], 'one-word placeholders belong to commands');
  assert.deepEqual(findBlanks('See <a href="x">here</a>.'), [], 'an HTML tag');
  assert.deepEqual(findBlanks('Keep a < b and c > d.'), [], 'a comparison');
  assert.deepEqual(findBlanks('Unclosed <looks fine / what'), []);
});

test('findBlanks: a lone description or a yes/no list is a slot too', () => {
  const [one, two] = findBlanks('Verdict: <your verdict>. Push: <yes/no>.');
  assert.deepEqual(one.choices, [{ label: 'your verdict', open: true }], 'a single choice always takes your own words');
  assert.deepEqual(two.choices, [
    { label: 'yes', open: false },
    { label: 'no', open: false },
  ]);
  assert.equal(findBlanks('<A / B / describe the bug…>')[0].choices[2].open, true);
});

test('findBlanks: a slot may quote a button, and a one-word answer slot counts', () => {
  const quoted = 'My answers from the page: <which answers did "Copy my answers" give>. Turn the first into a plan.';
  const [q] = findBlanks(quoted);
  assert.equal(q.text, 'which answers did "Copy my answers" give');
  assert.deepEqual(q.choices, [{ label: 'which answers did "Copy my answers" give', open: true }]);
  assert.equal(fillBlanks(quoted, [q], ['Q1 A, Q2 B']), 'My answers from the page: Q1 A, Q2 B. Turn the first into a plan.');
  assert.equal(findBlanks('Curly too: <what did “Copy” give>.').length, 1);
  assert.deepEqual(findBlanks('Answers from the page: <paste>. Then <Answers>.').map((b) => b.text), ['paste', 'Answers']);
  assert.deepEqual(findBlanks('See <a href="x">here</a>, <img alt="y">.'), [], 'a tag with attributes is still a tag');
  assert.deepEqual(findBlanks('Release note: `## v1 (<date>)`, then <id> and <paste-id>.'), [], 'code and command placeholders are not');
});

test('fillBlanks puts each answer in its place, and leaves an unanswered slot', () => {
  const b = findBlanks(PROMPT);
  assert.equal(fillBlanks(PROMPT, b, ['looks fine']), PROMPT.replace("<looks fine / what's wrong>", 'looks fine'));
  const two = 'A: <x or y>. B: <p / q>.';
  assert.equal(fillBlanks(two, findBlanks(two), ['  y  ', 'q']), 'A: y. B: q.');
  assert.equal(fillBlanks(two, findBlanks(two), ['', 'q']), 'A: <x or y>. B: q.');
  assert.equal(fillBlanks('none here', [], []), 'none here');
});

test('blankContext shows a few words before and after the slot', () => {
  const [b] = findBlanks(PROMPT);
  const c = blankContext(PROMPT, b, 30);
  assert.match(c, /^…[^ ]/, 'it starts on a whole word');
  assert.match(c, /My third look: <looks fine \/ what's wrong>\. Check the log/);
  assert.match(c, /…$/);
  assert.equal(blankContext('Look: <a / b>', findBlanks('Look: <a / b>')[0]), 'Look: <a / b>');
});

test('a kickoff prompt read from a reply keeps its slot', () => {
  const reply = `Done.\n\n**Kickoff prompt for the next session:**\n\n> ${PROMPT}\n`;
  const prompt = kickoffPrompt(reply);
  assert.ok(prompt);
  assert.equal(findBlanks(prompt).map((b) => b.text).join('|'), "looks fine / what's wrong");
});
