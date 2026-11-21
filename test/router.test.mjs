// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const r = createRequire(import.meta.url)('../extension/router.js');
const NOW = Date.UTC(2026, 10, 21, 16, 0) ;
const inAnHour = NOW / 1000 + 3600;
const noLog = () => {};

// Prompts that no rule matches, so the models decide.
const NEUTRAL = 'Write a unit test for a function that reverses a string';

test('Qwen LOCAL is final; Haiku is never asked', async () => {
  let haikuCalls = 0;
  const out = await r.classify({ prompt: NEUTRAL }, { qwen: async () => ({ label: 'LOCAL', tokens: 1 }), haiku: async () => { haikuCalls++; }, log: noLog });
  assert.equal(out.tier, 'local');
  assert.equal(haikuCalls, 0);
});

test('Qwen FRONTIER is checked by Haiku, which can send it back to local', async () => {
  const deps = (label) => ({ qwen: async () => ({ label: 'FRONTIER', tokens: 1 }), haiku: async () => ({ label, tokens: 1 }), log: noLog });
  assert.equal((await r.classify({ prompt: NEUTRAL }, deps('LOCAL'))).tier, 'local');
  assert.equal((await r.classify({ prompt: NEUTRAL }, deps('FRONTIER'))).tier, 'frontier');
});

test('with the local model down, everything goes frontier without asking Haiku', async () => {
  let haikuCalls = 0;
  const out = await r.classify({ prompt: NEUTRAL }, { qwen: async () => { throw new Error('refused'); }, haiku: async () => { haikuCalls++; }, log: noLog });
  assert.equal(out.tier, 'frontier');
  assert.match(out.trail.join(' '), /offline/);
  assert.equal(haikuCalls, 0);
});

test('when Haiku fails, it errs toward frontier', async () => {
  const fail = async () => { throw new Error('boom'); };
  assert.equal((await r.classify({ prompt: NEUTRAL }, { qwen: async () => ({ label: 'FRONTIER' }), haiku: fail, log: noLog })).tier, 'frontier');
});

test('rules decide before any model is asked', async () => {
  const never = { qwen: async () => assert.fail('Qwen asked'), haiku: async () => assert.fail('Haiku asked'), log: noLog };
  const rule = async (ctx) => { const out = await r.classify(ctx, never); return [out.tier, out.trail[0]]; };
  assert.deepEqual(await rule({ prompt: 'Review how we store passwords' }), ['frontier', 'rule: mentions "password"']);
  assert.deepEqual(await rule({ prompt: 'Plan the database migration' }), ['frontier', 'rule: mentions "migrat"']);
  assert.deepEqual(await rule({ prompt: 'Add a docstring to parse()' }), ['local', 'rule: "docstring" task']);
  assert.deepEqual(await rule({ prompt: 'Add a docstring to the login handler' }), ['frontier', 'rule: mentions "login"'], 'frontier keywords beat local ones');
});

test('size, file count and repo paths escalate deterministically', () => {
  const big = r.applyRules({ prompt: NEUTRAL, files: [{ path: 'a.js', bytes: 200_000 }], localContext: 65536 });
  assert.equal(big.tier, 'frontier');
  assert.match(big.trail[0], /over 50% of the local context/);
  assert.equal(r.applyRules({ prompt: NEUTRAL, files: [{ path: 'a', bytes: 1 }, { path: 'b', bytes: 1 }, { path: 'c', bytes: 1 }] }).tier, 'frontier');
  const rules = { ...r.DEFAULT_RULES, frontierPaths: ['src/billing/**'] };
  assert.match(r.applyRules({ prompt: NEUTRAL, files: [{ path: 'src/billing/invoice.ts', bytes: 10 }], rules }).trail[0], /frontier list/);
  assert.equal(r.applyRules({ prompt: NEUTRAL, files: [{ path: 'src/ui/button.ts', bytes: 10 }], rules }), null);
});

test('conversation rules: follow-ups stick, repeated local failures escalate', () => {
  const after = (backend) => [{ user: 'x', meta: { backend } }];
  assert.deepEqual(r.applyRules({ prompt: 'make it shorter', turns: after('claude') }), { tier: 'same', backend: 'claude', trail: ['rule: short follow-up stays with Claude'] });
  assert.equal(r.applyRules({ prompt: 'make it shorter', turns: after('local') }), null);
  const twoLocal = [...after('local'), ...after('local')];
  assert.match(r.applyRules({ prompt: "that didn't work, the tests still fail", turns: twoLocal }).trail[0], /tried 2 times/);
  assert.equal(r.applyRules({ prompt: "that didn't work", turns: after('local') }), null, 'one local attempt is not enough');
});

test('a repo can extend the rules in .agents/routing.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loadout-rules-'));
  mkdirSync(join(dir, '.agents'));
  writeFileSync(join(dir, '.agents/routing.json'), JSON.stringify({ frontierKeywords: ['ledger'], maxLocalFiles: 5, unknown: 1 }));
  const rules = r.loadRules(dir);
  assert.ok(rules.frontierKeywords.includes('ledger') && rules.frontierKeywords.includes('password'), 'lists are added to the defaults');
  assert.equal(rules.maxLocalFiles, 5);
  assert.equal(rules.unknown, undefined);
  assert.equal(r.applyRules({ prompt: 'Update the ledger totals', rules }).tier, 'frontier');
  assert.deepEqual(r.loadRules(join(dir, 'nope')), r.DEFAULT_RULES);
});

test('frontier work goes to the subscription with more 5-hour headroom', () => {
  const w = (used, extra = {}) => ({ used, resetsAt: inAnHour, blocked: false, ...extra });
  assert.equal(r.pickFrontier({ claude: w(0.8), codex: w(0.3) }, 'balance', NOW).backend, 'codex');
  assert.equal(r.pickFrontier({ claude: w(0.2), codex: w(0.3) }, 'balance', NOW).backend, 'claude');
  assert.equal(r.pickFrontier({ claude: w(0.2), codex: w(0.1, { blocked: true }) }, 'balance', NOW).backend, 'claude', 'blocked counts as empty');
  assert.equal(r.pickFrontier({ claude: w(0.99), codex: w(0.5) }, 'claude', NOW).backend, 'codex', 'a preference yields when nearly out');
  assert.equal(r.pickFrontier({ claude: w(0.4), codex: w(0.1) }, 'claude', NOW).backend, 'claude');
  const expired = { used: 0.99, resetsAt: NOW / 1000 - 60, blocked: true };
  assert.equal(r.pickFrontier({ claude: expired, codex: w(0.5) }, 'balance', NOW).backend, 'claude', 'a window that already reset is full again');
  assert.equal(r.pickFrontier({}, 'balance', NOW).backend, 'claude', 'no data: Claude');
});

test('reads the windows both CLIs report', () => {
  const claude = r.claudeWindow({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.35, resetsAt: 1795286400, status: 'allowed' }, seven_day: { utilization: 0.13, resetsAt: 1795647600, status: 'allowed' } } });
  assert.deepEqual(claude, { used: 0.35, resetsAt: 1795286400, blocked: false, weekUsed: 0.13 });
  const codex = r.codexWindow({ limit_id: 'codex', primary: { used_percent: 99.0, window_minutes: 300, resets_at: 1794719462 }, secondary: { used_percent: 27.0 }, rate_limit_reached_type: null });
  assert.deepEqual(codex, { used: 0.99, resetsAt: 1794719462, blocked: false, weekUsed: 0.27 });
  assert.equal(r.codexWindow({ limit_id: 'codex', primary: null }), null);
});

test('Claude stream: session, tool progress, reply, usage, limits', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: 'abc' },
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1, status: 'allowed' } } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'result', subtype: 'success', session_id: 'abc', is_error: false, result: 'done', total_cost_usd: 0.01,
      usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 } },
  ];
  const s = events.reduce(r.claudeEvent, r.claudeState());
  assert.deepEqual([s.sessionId, s.text, s.inTok, s.outTok, s.limits.used, s.progress], ['abc', 'done', 112, 5, 0.5, ['Running `ls`']]);
});

test('Codex stream: thread, commands, last message, usage, errors', () => {
  const events = [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'item.started', item: { type: 'command_execution', command: "/bin/bash -lc 'ls'" } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'final' } },
    { type: 'turn.completed', usage: { input_tokens: 300, output_tokens: 7 } },
  ];
  const s = events.reduce(r.codexEvent, r.codexState());
  assert.deepEqual([s.sessionId, s.text, s.inTok, s.outTok, s.error, s.progress.length], ['t1', 'final', 300, 7, null, 1]);
  assert.equal(r.codexEvent(r.codexState(), { type: 'turn.failed', error: { message: 'usage limit reached' } }).error, 'usage limit reached');
});

test('a backend resumes its own session and is told what other backends said since', () => {
  const turns = [
    { user: 'plan it', assistant: 'the plan', meta: { backend: 'claude', sessionId: 'c1' } },
    { user: 'write the boilerplate', assistant: 'wrote it', meta: { backend: 'local', sessionId: 'l1' } },
  ];
  const claude = r.plan(turns, 'claude', 'review it');
  assert.equal(claude.sessionId, 'c1');
  assert.match(claude.prompt, /write the boilerplate[\s\S]*Local model[\s\S]*Current request: review it/);
  assert.doesNotMatch(claude.prompt, /plan it/, 'Claude already has its own turn');
  const codex = r.plan(turns, 'codex', 'review it');
  assert.equal(codex.sessionId, null);
  assert.match(codex.prompt, /plan it[\s\S]*write the boilerplate/);
  assert.deepEqual(r.plan([], 'claude', 'hi'), { sessionId: null, prompt: 'hi' });
});
