// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The learner's log goes to a scratch file for these tests.
process.env.FUSEWAY_LEARNING_LOG = join(mkdtempSync(join(tmpdir(), 'fuseway-learn-')), 'learning.jsonl');
const require = createRequire(import.meta.url);
const L = require('../extension/learner.js');
const R = require('../extension/router.js');
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 21);

// n labeled decisions for one router, `daysAgo` old, `right` of them correct, each costing `tokens` paid tokens.
function history(key, { n, right, daysAgo, tokens = 0, ms = 300, start = 0 }) {
  const events = [];
  for (let i = 0; i < n; i++) {
    const id = `${key}-${daysAgo}-${start + i}`, ts = NOW - daysAgo * DAY;
    events.push({ type: 'decision', id, ts, local: true, routers: { [key]: i < right ? 'local' : 'frontier' }, cost: { [key]: { tokens, ms } } });
    events.push({ type: 'outcome', id, ts, outcome: 'success' });
  }
  return events;
}
const scores = (events) => L.routerScores(events, NOW);

test('recent strong results beat a long, mediocre record', () => {
  const events = [...history('old@q', { n: 300, right: 255, daysAgo: 40 }), ...history('old@q', { n: 10, right: 8, daysAgo: 1, start: 1000 }),
    ...history('new@q', { n: 20, right: 19, daysAgo: 1 })];
  const s = scores(events);
  assert.ok(s['new@q'].score > s['old@q'].score, `new ${s['new@q'].score} vs old ${s['old@q'].score}`);
  assert.ok(s['old@q'].evidence < 30, 'six-week-old results have faded: 300 old results are not 300 votes');
  const pick = L.choose(s, { key: 'old@q', since: NOW - 7 * DAY }, NOW);
  assert.deepEqual([pick.key, pick.switched], ['new@q', true]);
});

test('a challenger needs enough recent evidence, a clear lead and a cooled-down router', () => {
  const champ = history('champ@q', { n: 40, right: 34, daysAgo: 1 }); // 85%
  const cur = { key: 'champ@q', since: NOW - 7 * DAY };
  const thin = scores([...champ, ...history('c@q', { n: 5, right: 5, daysAgo: 1 })]);
  assert.equal(L.choose(thin, cur, NOW).switched, false, '5 perfect results are not enough evidence');
  const close = scores([...champ, ...history('c@q', { n: 40, right: 35, daysAgo: 1 })]); // 87.5%: under the 3-point margin
  assert.equal(L.choose(close, cur, NOW).switched, false);
  const clear = scores([...champ, ...history('c@q', { n: 40, right: 38, daysAgo: 1 })]); // 95%
  assert.equal(L.choose(clear, cur, NOW).key, 'c@q');
  assert.equal(L.choose(clear, { key: 'champ@q', since: NOW - 2 * 3_600_000 }, NOW).reason, 'cooling down');
});

test('paid tokens and latency count against a router', () => {
  const s = scores([...history('haiku', { n: 30, right: 27, daysAgo: 1, tokens: 1100, ms: 1900 }), ...history('free@q', { n: 30, right: 27, daysAgo: 1 })]);
  assert.ok(s['free@q'].score > s.haiku.score);
  assert.equal(Math.round(s.haiku.tokensPerDecision), 1100);
});

test('a router tied to a replaced local model hands over to the best available one', () => {
  const s = scores([...history('cascade@old-model', { n: 30, right: 29, daysAgo: 1 }), ...history('haiku', { n: 30, right: 25, daysAgo: 1 })]);
  const pick = L.choose(s, { key: 'cascade@old-model', since: NOW - 3_600_000 }, NOW, (k) => !k.endsWith('@old-model'));
  assert.deepEqual([pick.key, pick.switched], ['haiku', true]);
  assert.match(pick.reason, /no longer available/);
});

test('outcomes come from the next message, and only local answers produce labels', () => {
  const prev = { decisionId: 'd1', backend: 'local' };
  assert.equal(L.outcomeFromNextTurn(prev, "that didn't work", undefined), 'fail');
  assert.equal(L.outcomeFromNextTurn(prev, 'do the same for the other file', 'claude'), null, 'asking another backend can be a deliberate comparison');
  assert.equal(L.outcomeFromNextTurn(prev, 'now add a test for it', undefined), null);
  assert.equal(L.outcomeFromNextTurn({ backend: 'local' }, 'x', undefined), null, 'no decision, no outcome');
  assert.equal(L.labelFor({ local: true }, 'success'), 'local');
  assert.equal(L.labelFor({ local: true }, 'fail'), 'frontier');
  assert.equal(L.labelFor({ local: false }, 'success'), null, 'a frontier success does not show local would have failed');
  assert.equal(L.labelFor({ local: true, escalated: true }, undefined), null);
});

test('explicit feedback overrides the implicit outcome, for decisions and agents', () => {
  const events = [
    { type: 'decision', id: 'd', ts: NOW, local: true, routers: { 'a@q': 'local' } },
    { type: 'outcome', id: 'd', ts: NOW + 1, outcome: 'fail', explicit: true },
    { type: 'outcome', id: 'd', ts: NOW + 2, outcome: 'success' },
    { type: 'agent', attempt: 't1', ts: NOW, agent: 'local:q', outcome: 'fail', explicit: true },
    { type: 'agent', attempt: 't1', ts: NOW + 2, agent: 'local:q', outcome: 'success' },
  ];
  assert.equal(L.decisions(events)[0].label, 'frontier');
  const agents = L.agentScores(events, NOW);
  assert.deepEqual([agents['local:q'].n, agents['local:q'].success], [1, 0]);
});

test('labeled test cases count at half weight, and the learner tracks what it spent today', () => {
  const bench = [{ type: 'bench', key: 'haiku', ts: NOW, want: 'local', tier: 'local', tokens: 1000, background: true },
    { type: 'bench', key: 'haiku', ts: NOW - 2 * DAY, want: 'local', tier: 'frontier', tokens: 1000, background: true }];
  const s = scores(bench);
  assert.ok(Math.abs(s.haiku.evidence - 0.5 * (1 + L.weight(NOW - 2 * DAY, NOW))) < 1e-9);
  assert.equal(L.paidToday(bench, NOW), 1000, 'only the last 24 hours');
});

test('cascade reveals local-only but its hinted Haiku answer is not an independent shadow', () => {
  assert.deepEqual(R.freeShadows('cascade', { tier: 'local', trail: ['rule ≈ regex (strong)'] }), { 'local-only': 'local' });
  assert.deepEqual(R.freeShadows('cascade', { tier: 'local', trail: ['rule ≈ caching (weak)', 'Haiku: LOCAL'] }), { 'local-only': 'frontier' });
  assert.deepEqual(R.freeShadows('cascade', { tier: 'frontier', structural: true, trail: ['rule: 3 files attached'] }), {});
});

test('classifyWith runs each candidate and counts its paid tokens', async () => {
  const deps = (haikuLabel) => ({ qwen: async () => ({ tier: 'FRONTIER', matches: [], tokens: 1 }), haiku: async () => ({ label: haikuLabel, tokens: 900 }), log: () => {} });
  const prompt = 'Write a quick check of a function that reverses a string';
  const cascade = await R.classifyWith('cascade', { prompt }, deps('LOCAL'));
  assert.deepEqual([cascade.tier, cascade.paidTokens], ['local', 900]);
  const localOnly = await R.classifyWith('local-only', { prompt }, deps('LOCAL'));
  assert.deepEqual([localOnly.tier, localOnly.paidTokens, localOnly.trail.at(-1)], ['frontier', 0, 'no tiebreaker: frontier']);
  const haiku = await R.classifyWith('haiku', { prompt }, deps('LOCAL'));
  assert.deepEqual([haiku.tier, haiku.paidTokens], ['local', 900]);
});

test('the background pass runs free routers always, paid ones within the budget, and stops when asked', async () => {
  rmSync(process.env.FUSEWAY_LEARNING_LOG, { force: true });
  const now = Date.now();
  L.append({ type: 'decision', id: 'd1', ts: now - 60_000, prompt: 'add a docstring', context: R.routingSnapshot({ prompt: 'add a docstring' }), localModel: 'q', local: true, routers: { 'cascade@q': 'local' } });
  const calls = [];
  const classifyWith = async (name) => { calls.push(name); return { tier: 'local', trail: [], paidTokens: name === 'local-only' ? 0 : 1000, ms: 5 }; };
  await L.tick({ classifyWith, offline: () => false, localModel: 'q', budget: 1500, now, maxJobs: 50 });
  const events = L.load(now);
  const filled = events.filter((e) => e.type === 'router' && e.id === 'd1').map((e) => e.key).sort();
  assert.deepEqual(filled, ['haiku', 'local-only@q'], 'the decision gets the other routers’ answers');
  assert.ok(L.paidToday(events, now) <= 2000, 'stops paying once the budget is used');
  assert.ok(events.some((e) => e.type === 'bench' && e.key === 'local-only@q'), 'a thin free router gets test cases');
  assert.ok(!events.some((e) => e.type === 'bench' && e.key === 'haiku' && L.paidToday(events, now) > 1500), 'no paid test cases over budget');

  rmSync(process.env.FUSEWAY_LEARNING_LOG, { force: true });
  calls.length = 0;
  await L.tick({ classifyWith, offline: () => false, localModel: 'q', budget: 0, now, isBusy: () => true });
  assert.equal(calls.length, 0, 'does nothing while a request is running');
  await L.tick({ classifyWith: async () => ({ tier: 'frontier', trail: ['local model offline (refused)'], paidTokens: 0 }), offline: (o) => o.trail[0].startsWith('local model offline'), localModel: 'q', budget: 0, now });
  assert.equal(L.load(now).filter((e) => e.type === 'bench').length, 0, 'records nothing when the local model is down');
});

test('reconsider switches once there is clear recent evidence, and logs why', () => {
  rmSync(process.env.FUSEWAY_LEARNING_LOG, { force: true });
  const now = Date.now();
  for (const e of [...history('cascade@q', { n: 30, right: 24, daysAgo: 0 }), ...history('local-only@q', { n: 30, right: 29, daysAgo: 0 })]) L.append({ ...e, ts: now - 1000 });
  const pick = L.reconsider('q', now);
  assert.deepEqual([pick.key, pick.switched], ['local-only@q', true]);
  assert.equal(L.currentRouter(L.load(now), 'q').key, 'local-only@q');
  assert.equal(L.reconsider('q', now).reason, 'cooling down', 'no second switch the same day');
});
