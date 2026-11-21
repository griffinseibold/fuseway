import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const R = require('../extension/router.js');
const L = require('../extension/learner.js');
const scratch = mkdtempSync(join(tmpdir(), 'fuseway-grok-test-'));
function load(file, overrides = {}, globals = {}) {
  const filename = resolve(file), module = { exports: {} }, localRequire = createRequire(filename);
  runInNewContext(readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: (id) => overrides[id] || localRequire(id), __dirname: resolve(file, '..'),
    process, Buffer, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, ...globals }, { filename });
  return module.exports;
}
const end = (extra = {}) => ({ type: 'end', stopReason: 'end_turn', sessionId: 'g1',
  usage: { input_tokens: 12, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 4, reasoning_tokens: 2 },
  modelUsage: { 'grok-observed': { modelCalls: 2 } }, ...extra });
function runner(events, { code = 0, error, wait = false } = {}) {
  const calls = [];
  let child;
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('close', 143); };
    queueMicrotask(() => {
      if (error) child.emit('error', error);
      else if (!wait) {
        child.stdout.emit('data', events.map(JSON.stringify).join('\n') + '\n');
        child.emit('close', code);
      }
    });
    return child;
  };
  const r = load('extension/router.js', { child_process: { spawn } }, {
    process: { ...process, env: { ...process.env, GROK_BIN: '/custom/grok', FUSEWAY_STATE_DIR: scratch,
      FUSEWAY_CODEX_SESSIONS: join(scratch, 'sessions') } },
  });
  return { r, calls, getChild: () => child };
}

test('Grok native stream reports aggregate spend and observed models once', async () => {
  const { r, calls } = runner([
    { type: 'text', data: 'Read it. ' },
    { type: 'tool_call', toolName: 'read_file', rawInput: { path: '/repo/a.js' } },
    { type: 'usage', usage: { input_tokens: 400, output_tokens: 100 } },
    { type: 'text', data: 'Done.' },
    end({ modelUsage: { 'grok-observed': {}, 'grok-helper': {} }, total_cost_usd: 0.012 }),
  ]);
  const progress = [];
  const result = await r.run('grok', { prompt: 'review it', cwd: '/repo', sessionId: 'previous', grokModel: 'requested', allowEdits: true, onProgress: (p) => progress.push(p) });
  assert.equal(result.text, 'Read it. Done.');
  assert.equal(result.sessionId, 'g1');
  assert.equal(result.model, 'grok-observed + grok-helper');
  assert.equal(result.requestedModel, 'requested');
  assert.equal(result.inTok, 47);
  assert.equal(result.outTok, 4);
  assert.equal(result.costUsd, 0.012);
  assert.equal(result.usageIncomplete, false);
  assert.equal(progress[0], 'read_file a.js');
  const { bin, args, opts } = calls[0];
  assert.equal(bin, '/custom/grok');
  assert.equal(opts.cwd, '/repo');
  assert.equal(opts.env.FUSION_CHILD, '1');
  for (const [flag, value] of [['--sandbox', 'workspace'], ['--resume', 'previous'], ['--model', 'requested'], ['--output-format', 'streaming-json'], ['--deny', 'MCPTool'], ['--disallowed-tools', 'Agent']])
    assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes('--no-auto-update'));
  assert.match(r.usageMarkdown(), /grok:grok-observed \+ grok-helper:agent/);
});

test('Grok read-only execution passes the read-only sandbox', async () => {
  const { r, calls } = runner([{ type: 'text', data: 'answer' }, end()]);
  await r.run('grok', { prompt: 'explain', cwd: '/repo', allowEdits: false });
  const args = calls[0].args;
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args.includes('--model'), false);
  assert.equal(args.includes('--resume'), false);
});

test('missing Grok spend and model data stay unknown', async () => {
  const { r } = runner([{ type: 'text', data: 'answer' }, { type: 'end', stopReason: 'end_turn' }]);
  const result = await r.run('grok', { prompt: 'explain', cwd: '/repo', grokModel: 'requested' });
  assert.equal(result.model, 'unknown');
  assert.equal(result.requestedModel, 'requested');
  assert.equal(result.inTok, undefined);
  assert.equal(result.outTok, undefined);
  assert.equal(result.costUsd, undefined);
  assert.equal(result.usageIncomplete, true);
  assert.match(r.usageMarkdown(), /0 \+ unknown/);
  const stats = L.statsMarkdown([{ type: 'agent', attempt: 'u', agent: 'grok:unknown:agent', ts: Date.now(), usageIncomplete: true }], 'q');
  assert.match(stats, /grok:unknown:agent.*0 \+ unknown/);
});

test('partial or incomplete Grok cost is never reported as complete', () => {
  for (const partial of [{ cost_is_partial: true }, { usage_is_incomplete: true }]) {
    const s = R.grokEvent(R.grokState(), end({ total_cost_usd: 9, ...partial }));
    assert.equal(s.costUsd, undefined);
  }
  const s = R.grokEvent(R.grokState(), end());
  assert.equal(s.costUsd, undefined);
});

test('Grok truncation, missing completion, errors and nonzero exits reject partial text', async () => {
  for (const [events, options, pattern] of [
    [[{ type: 'text', data: 'partial' }], {}, /missing end event/],
    [[{ type: 'text', data: 'partial' }, end({ stopReason: 'max_tokens' })], {}, /max_tokens/],
    [[{ type: 'error', message: 'rate limit reached', ...end(), type: 'error' }], {}, /rate limit/],
    [[{ type: 'text', data: 'partial' }, end()], { code: 1 }, /exited 1/],
  ]) {
    const { r } = runner(events, options);
    await assert.rejects(r.run('grok', { prompt: 'task', cwd: '/repo' }), pattern);
  }
});

test('missing Grok CLI explains setup and cancellation kills its process', async () => {
  const missing = runner([], { error: Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(missing.r.run('grok', { prompt: 'task', cwd: '/repo' }), /Grok Build CLI not found.*grok login/);
  const active = runner([], { wait: true }), ac = new AbortController();
  const pending = active.r.run('grok', { prompt: 'task', cwd: '/repo', signal: ac.signal });
  ac.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(active.getChild().killed, true);
});

test('Grok is selected explicitly, keeps continuations, and resumes only its own session', () => {
  assert.equal(R.pickFrontier({}, 'grok').backend, 'grok');
  assert.equal(R.pickFrontier({}).backend, 'claude');
  const turns = [{ user: 'plan', assistant: 'a plan', meta: { backend: 'grok', sessionId: 'g1' } }];
  assert.equal(R.applyRules({ prompt: 'make it shorter', turns }).backend, 'grok');
  assert.equal(R.plan(turns, 'grok', 'continue').sessionId, 'g1');
  const other = R.plan(turns, 'codex', 'review');
  assert.equal(other.sessionId, null);
  assert.match(other.prompt, /Assistant \(Grok\): a plan/);
});

function chatHarness({ command, preference = 'balance', run, classify, reserves = {}, limits = {} } = {}) {
  let callback;
  const calls = [], replies = [], events = [];
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (k, fallback) => k === 'frontier' ? preference : k === 'grokModel' ? 'grok-requested' : k in reserves ? reserves[k] : fallback }), workspaceFolders: [{ uri: { fsPath: '/repo' } }] },
    window: { createOutputChannel: () => ({ appendLine() {}, append() {}, show() {} }), setStatusBarMessage() {} },
    chat: { createChatParticipant: (_id, cb) => { callback = cb; return { onDidReceiveFeedback() {} }; } },
    commands: { registerCommand: () => ({}) }, ChatRequestTurn: class {}, ChatResponseTurn: class {}, Uri: class {}, ChatResultFeedbackKind: { Helpful: 1 },
  };
  const L = { POLICY: { defaultRouter: 'cascade' }, load: () => [], currentRouter: () => ({ key: 'cascade@q' }), routerName: () => 'cascade', routerKey: (n) => `${n}@q`,
    append: (e) => events.push(e), outcomeFromNextTurn: () => null, newId: (() => { let n = 0; return () => String(++n); })(), reconsider: () => ({ switched: false }), tick: async () => {} };
  const r = { ...R, localConfig: () => ({ model: 'q' }), readLimits: () => limits,
    classifyWith: classify || (async () => ({ tier: 'frontier', trail: [], ms: 1 })),
    run: async (backend, opts) => { calls.push({ backend, opts }); return run ? run(backend, opts) : { text: 'done', model: 'grok-observed', sessionId: 'g1', inTok: 10, outTok: 2, ms: 3 }; } };
  const extension = load('extension/extension.js', { vscode, './router': r, './learner': L }, { setTimeout: () => 1, clearTimeout() {} });
  extension.activate({ subscriptions: [], globalState: { get: () => true } });
  const execute = () => callback({ command, prompt: 'review', references: [] }, { history: [] }, { markdown: (s) => replies.push(s), progress() {} },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  return { execute, calls, replies, events };
}

test('forced Grok bypasses routing, propagates model choice and reports its model', async () => {
  const chat = chatHarness({ command: 'grok', classify: () => assert.fail('forced backend must not classify') });
  await chat.execute();
  assert.equal(chat.calls.length, 1);
  assert.equal(chat.calls[0].backend, 'grok');
  assert.equal(chat.calls[0].opts.grokModel, 'grok-requested');
  assert.match(chat.replies.join(''), /Grok \(grok-observed\)/);
  assert.equal(chat.events.find((e) => e.type === 'agent').agent, 'grok:grok-observed:agent');
});

test('forced Grok errors never call another backend', async () => {
  const chat = chatHarness({ command: 'grok', run: async () => { throw new R.BackendError('rate limit', true); } });
  await chat.execute();
  assert.equal(chat.calls.length, 1);
  assert.match(chat.replies.join(''), /rate limit/);
});

test('Grok preference uses Grok and quota failover returns to ordinary balanced backends', async () => {
  const chat = chatHarness({ preference: 'grok', run: async (backend) => {
    if (backend === 'grok') throw new R.BackendError('rate limit', true);
    return { text: 'done', model: 'fallback-model', inTok: 1, outTok: 1, ms: 2 };
  } });
  await chat.execute();
  assert.deepEqual(chat.calls.map((c) => c.backend), ['grok', 'claude']);
  const balanced = chatHarness();
  await balanced.execute();
  assert.equal(balanced.calls[0].backend, 'claude');
});


test('Grok quota failover honors the configured subscription reserves', async () => {
  const resetsAt = Date.now() / 1000 + 3600;
  const chat = chatHarness({ preference: 'grok', reserves: { claudeReserve: 0.6, codexReserve: 0 },
    limits: { claude: { used: 0.4, resetsAt }, codex: { used: 0.5, resetsAt } },
    run: async (backend) => {
      if (backend === 'grok') throw new R.BackendError('rate limit', true);
      return { text: 'done', model: 'fallback', inTok: 1, outTok: 1, ms: 1 };
    } });
  await chat.execute();
  assert.deepEqual(chat.calls.map((c) => c.backend), ['grok', 'codex']);
});
