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

// Prompts that no keyword matches, so the models decide.
const NEUTRAL = 'Write a unit test for a function that reverses a string'.replace('unit test for', 'quick check of');
const qwenSays = (tier, matches = []) => async () => ({ tier, matches, tokens: 1 });
const route = async (qwen, haiku = async () => assert.fail('Haiku asked')) => {
  const hints = [];
  const out = await r.classify({ prompt: NEUTRAL }, { qwen, haiku: async (i, hint) => { hints.push(hint); return haiku(i, hint); }, log: noLog });
  return { ...out, hints };
};

test('a strong frontier match goes frontier without asking Haiku', async () => {
  const out = await route(qwenSays('LOCAL', [{ id: 'docstrings', strength: 'strong' }, { id: 'concurrency', strength: 'strong' }]));
  assert.deepEqual([out.tier, out.trail], ['frontier', ['rule ≈ concurrency (strong)']], 'frontier beats local');
});

test('a weak frontier match asks Haiku, with the rule as a hint', async () => {
  const out = await route(qwenSays('LOCAL', [{ id: 'caching', strength: 'weak' }]), async () => ({ label: 'LOCAL', tokens: 1 }));
  assert.equal(out.tier, 'local');
  assert.match(out.hints[0], /Caching strategy/);
  assert.deepEqual(out.trail, ['rule ≈ caching (weak)', 'Haiku: LOCAL']);
});

test('a strong local match stays local; otherwise Qwen decides and Haiku checks FRONTIER', async () => {
  assert.equal((await route(qwenSays('FRONTIER', [{ id: 'regex', strength: 'strong' }]))).tier, 'local');
  assert.equal((await route(qwenSays('LOCAL', [{ id: 'regex', strength: 'weak' }]))).tier, 'local');
  assert.equal((await route(qwenSays('LOCAL'))).tier, 'local');
  const checked = await route(qwenSays('FRONTIER'), async () => ({ label: 'FRONTIER', tokens: 1 }));
  assert.deepEqual([checked.tier, checked.hints], ['frontier', [undefined]]);
  assert.equal((await route(qwenSays('LOCAL', [{ id: 'made-up-rule', strength: 'strong' }]))).tier, 'local', 'unknown ids are ignored');
});

test('with the local model down, everything goes frontier without asking Haiku', async () => {
  const out = await route(async () => { throw new Error('refused'); });
  assert.equal(out.tier, 'frontier');
  assert.match(out.trail.join(' '), /offline/);
});

test('when Haiku fails, it errs toward frontier', async () => {
  const out = await route(qwenSays('FRONTIER'), async () => { throw new Error('boom'); });
  assert.equal(out.tier, 'frontier');
});

test('a frontier keyword never goes local on the local model alone', async () => {
  const deps = (qwen, label) => ({ qwen, haiku: async () => ({ label, tokens: 1 }), log: noLog });
  const strong = await r.classify({ prompt: 'Review how we store passwords' }, deps(qwenSays('LOCAL', [{ id: 'secrets', strength: 'strong' }]), 'LOCAL'));
  assert.deepEqual([strong.tier, strong.trail], ['frontier', ['rule: secrets ("password")', 'rule ≈ secrets (strong)']], 'keyword plus a strong match: no Haiku');
  const checked = await r.classify({ prompt: 'Change the copyright year in the footer' }, deps(qwenSays('LOCAL', [{ id: 'wording', strength: 'strong' }]), 'LOCAL'));
  assert.deepEqual([checked.tier, checked.trail], ['local', ['rule: legal-licensing ("copyright")', 'needs a frontier check', 'Haiku: LOCAL']]);
  const held = await r.classify({ prompt: 'Change the copyright year in the footer' }, deps(qwenSays('LOCAL'), 'FRONTIER'));
  assert.equal(held.tier, 'frontier');
  const offline = await r.classify({ prompt: 'Review how we store passwords' }, deps(async () => { throw new Error('down'); }, 'LOCAL'));
  assert.equal(offline.tier, 'frontier');
});

test('a local keyword stays local unless the model finds something riskier', async () => {
  const never = async () => assert.fail('Haiku asked');
  const local = await r.classify({ prompt: 'Add a docstring to parse()' }, { qwen: qwenSays('FRONTIER'), haiku: never, log: noLog });
  assert.deepEqual([local.tier, local.trail], ['local', ['rule: docstrings ("docstring")']]);
  const riskier = await r.classify({ prompt: 'Add a docstring to parse()' }, { qwen: qwenSays('LOCAL', [{ id: 'privacy', strength: 'strong' }]), haiku: never, log: noLog });
  assert.equal(riskier.tier, 'frontier');
});

test('keywords match whole words unless they end in *', () => {
  const cat = r.loadRules().catalog;
  const hit = (text) => r.keywordHit(cat, 'frontier', text)?.rule.id ?? null;
  assert.equal(hit('fix the helmet styles'), null, '"helm" is not a prefix');
  assert.equal(hit('one slow page'), null, '"slo" is not a prefix');
  assert.equal(hit('write the migration'), 'schema-change', '"migrat*" is a stem');
  assert.equal(hit('we need SSO'), 'authentication');
  assert.equal(r.keywordHit(cat, 'local', 'write an .env.example')?.rule.id, 'config-example');
});

test('size, file count and repo paths escalate deterministically', () => {
  const big = r.applyRules({ prompt: NEUTRAL, files: [{ path: 'a.js', bytes: 200_000 }], localContext: 65536 });
  assert.equal(big.tier, 'frontier');
  assert.match(big.trail[0], /over 50% of the local context/);
  assert.equal(r.applyRules({ prompt: NEUTRAL, files: [{ path: 'a', bytes: 1 }, { path: 'b', bytes: 1 }, { path: 'c', bytes: 1 }] }).tier, 'frontier');
  const rules = { ...r.loadRules(), frontierPaths: ['src/billing/**'] };
  assert.match(r.applyRules({ prompt: NEUTRAL, files: [{ path: 'src/billing/invoice.ts', bytes: 10 }], rules }).trail[0], /frontier list/);
  assert.equal(r.applyRules({ prompt: NEUTRAL, files: [{ path: 'src/ui/button.ts', bytes: 10 }], rules }), null);
});

test('conversation rules: follow-ups stick, repeated local failures escalate', () => {
  const after = (backend) => [{ user: 'x', meta: { backend } }];
  assert.deepEqual(r.applyRules({ prompt: 'make it shorter', turns: after('claude') }), { tier: 'same', backend: 'claude', structural: true, trail: ['rule: short follow-up stays with Claude'] });
  assert.equal(r.applyRules({ prompt: 'make it shorter', turns: after('local') }), null);
  const twoLocal = [...after('local'), ...after('local')];
  assert.match(r.applyRules({ prompt: "that didn't work, the tests still fail", turns: twoLocal }).trail[0], /tried 2 times/);
  assert.equal(r.applyRules({ prompt: "that didn't work", turns: after('local') }), null, 'one local attempt is not enough');
});

test('a repo can add, disable and tune rules in .agents/routing.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuseway-rules-'));
  mkdirSync(join(dir, '.agents'));
  writeFileSync(join(dir, '.agents/routing.json'), JSON.stringify({
    frontierKeywords: ['ledger'], disable: ['styling'], maxLocalFiles: 5, unknown: 1,
    rules: [{ id: 'billing-ui', route: 'frontier', description: 'Anything on the billing screens' }, { id: 'bad', route: 'maybe', description: 'x' }] }));
  const rules = r.loadRules(dir);
  const ids = rules.catalog.map((x) => x.id);
  assert.ok(ids.includes('billing-ui') && ids.includes('repo-frontier') && ids.includes('secrets'));
  assert.ok(!ids.includes('styling') && !ids.includes('bad'));
  assert.equal(rules.maxLocalFiles, 5);
  assert.equal(rules.unknown, undefined);
  assert.equal(r.keywordHit(rules.catalog, 'frontier', 'Update the ledger totals').rule.id, 'repo-frontier');
  assert.equal(r.loadRules(join(dir, 'nope')).catalog.length, r.loadRules().catalog.length);
});

test('the shipped catalog is well formed', () => {
  const cat = r.loadRules().catalog;
  assert.ok(cat.length >= 70);
  assert.equal(new Set(cat.map((x) => x.id)).size, cat.length, 'unique ids');
  for (const x of cat) assert.ok(['local', 'frontier'].includes(x.route) && x.description, x.id);
});

test('frontier work goes to the subscription with more headroom left after its reserve', () => {
  const w = (used, extra = {}) => ({ used, resetsAt: inAnHour, blocked: false, ...extra });
  const none = { claude: 0, codex: 0 };
  const pick = (limits, prefer = 'balance', reserve = none) => r.pickFrontier(limits, prefer, NOW, reserve).backend;
  assert.equal(pick({ claude: w(0.8), codex: w(0.3) }), 'codex');
  assert.equal(pick({ claude: w(0.2), codex: w(0.3) }), 'claude');
  assert.equal(pick({ claude: w(0.2, { weekUsed: 0.9 }), codex: w(0.3) }), 'codex', 'the weekly window counts too');
  assert.equal(pick({ claude: w(0.2), codex: w(0.1, { blocked: true }) }), 'claude', 'blocked counts as empty');
  assert.equal(pick({ claude: w(0.99), codex: w(0.5) }, 'claude'), 'codex', 'a preference yields when nearly out');
  assert.equal(pick({ claude: w(0.4), codex: w(0.1) }, 'claude'), 'claude');
  const expired = { used: 0.99, resetsAt: NOW / 1000 - 60, blocked: true };
  assert.equal(pick({ claude: expired, codex: w(0.5) }), 'claude', 'a 5-hour window that already reset is full again');
  assert.equal(pick({}), 'claude', 'no data: Claude');
  assert.equal(pick({ claude: w(0.3), codex: w(0.5) }, 'balance', { claude: 0.2, codex: 0 }), 'claude', '70% left minus a 20% reserve still beats 50%');
  assert.equal(pick({ claude: w(0.65), codex: w(0.5) }, 'balance', { claude: 0.2, codex: 0 }), 'codex', 'the reserve keeps the rest of Claude for you');
  assert.equal(pick({ claude: w(0.85), codex: w(0.97) }, 'claude', { claude: 0.2, codex: 0 }), 'codex', 'the reserve holds even when both are nearly out');
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
