// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const r = createRequire(import.meta.url)('../extension/router.js');
const NOW = Date.UTC(2026, 10, 21, 16, 0) ;
const inAnHour = NOW / 1000 + 3600;
const noLog = () => {};

test('Qwen LOCAL is final; Haiku is never asked', async () => {
  let haikuCalls = 0;
  const out = await r.classify('add a docstring', null, { qwen: async () => ({ label: 'LOCAL', tokens: 1 }), haiku: async () => { haikuCalls++; }, log: noLog });
  assert.equal(out.tier, 'local');
  assert.equal(haikuCalls, 0);
});

test('Qwen FRONTIER is checked by Haiku, which can send it back to local', async () => {
  const deps = (label) => ({ qwen: async () => ({ label: 'FRONTIER', tokens: 1 }), haiku: async () => ({ label, tokens: 1 }), log: noLog });
  assert.equal((await r.classify('x', null, deps('LOCAL'))).tier, 'local');
  assert.equal((await r.classify('x', null, deps('FRONTIER'))).tier, 'frontier');
});

test('with the local model down, everything goes to a frontier model', async () => {
  const out = await r.classify('x', null, { qwen: async () => { throw new Error('refused'); }, haiku: async () => ({ label: 'LOCAL', tokens: 1 }), log: noLog });
  assert.equal(out.tier, 'frontier');
  assert.match(out.trail.join(' '), /offline/);
});

test('when both routers fail, it errs toward frontier', async () => {
  const fail = async () => { throw new Error('boom'); };
  assert.equal((await r.classify('x', null, { qwen: async () => ({ label: 'FRONTIER' }), haiku: fail, log: noLog })).tier, 'frontier');
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
