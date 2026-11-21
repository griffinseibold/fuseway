import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const R = require('../extension/router.js');
const scratch = mkdtempSync(join(tmpdir(), 'fuseway-routing-'));
function load(file, overrides = {}, globals = {}) {
  const filename = resolve(file), module = { exports: {} };
  const localRequire = createRequire(filename);
  runInNewContext(readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: (id) => overrides[id] || localRequire(id), __dirname: resolve(file, '..'),
    process, Buffer, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, ...globals }, { filename });
  return module.exports;
}
function learner() {
  return load('extension/learner.js', {}, { process: { ...process, env: { ...process.env, FUSEWAY_LEARNING_LOG: join(scratch, `${Math.random()}.jsonl`) } } });
}
function router(fetchImpl, childProcess) {
  const config = join(scratch, `${Math.random()}.json`);
  writeFileSync(config, JSON.stringify({ url: 'http://local.invalid', model: 'requested-local' }));
  return load('extension/router.js', childProcess ? { child_process: childProcess } : {}, {
    fetch: fetchImpl, process: { ...process, env: { ...process.env, FUSEWAY_STATE_DIR: scratch, FUSEWAY_LOCAL_CONFIG: config, FUSEWAY_CODEX_SESSIONS: join(scratch, 'sessions') } },
  });
}

test('new short topics reroute, continuations stay, safety gates win', () => {
  const turns = [{ user: 'Design a queue', meta: { backend: 'codex' } }];
  assert.equal(R.applyRules({ prompt: 'What is 2 + 2?', turns }), null);
  assert.equal(R.applyRules({ prompt: 'yes, design a completely new system', turns }), null);
  assert.equal(R.applyRules({ prompt: 'make it shorter', turns }).tier, 'same');
  const rules = { ...R.loadRules(), frontierPaths: ['billing/**'] };
  assert.equal(R.applyRules({ prompt: 'make it shorter', turns, rules, files: [{ path: 'billing/x' }] }).tier, 'frontier');
});

test('direct local execution is restricted to self-contained text and arithmetic', async () => {
  assert.equal(R.localExecution({ prompt: 'What is 2 + 2?' }), 'direct');
  assert.equal(R.localExecution({ prompt: 'Rewrite this text: hello' }), 'direct');
  for (const ctx of [{ prompt: 'Fix the parser' }, { prompt: 'What is 2 + 2?', turns: [{}] }, { prompt: 'Rewrite this text: hello', files: [{ path: 'a' }] }])
    assert.equal(R.localExecution(ctx), 'agent');
  let body;
  const r = router(async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model: 'actual-local', choices: [{ message: { content: '4' } }], usage: { prompt_tokens: 12, completion_tokens: 1 } }) };
  });
  const response = await r.run('local', { execution: 'direct', prompt: 'What is 2 + 2?' });
  assert.equal(response.text, '4');
  assert.equal(response.model, 'actual-local');
  assert.equal(response.inTok, 12);
  assert.equal(typeof response.ms, 'number');
  assert.equal(body.messages.length, 2);
  assert.equal(body.tools, undefined);
  assert.match(r.usageMarkdown(), /local:actual-local:direct/);
});

test('cancelling local execution or classification never becomes frontier work', async () => {
  const ac = new AbortController();
  const r = router(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const pending = r.run('local', { execution: 'direct', prompt: 'What is 2 + 2?', signal: ac.signal });
  ac.abort();
  await assert.rejects(pending, /cancelled/);
  const controller = new AbortController();
  await assert.rejects(R.classify({ prompt: 'a task', signal: controller.signal }, {
    qwen: async () => { controller.abort(); return { matches: [], tier: 'LOCAL' }; },
    haiku: async () => assert.fail('cancelled classification must not ask Haiku'), log: () => {},
  }), /cancelled/);
});

test('observed model IDs include mixed Claude models and latest exact Codex session', () => {
  const c = R.claudeState();
  R.claudeEvent(c, { type: 'system', model: 'claude-sonnet-exact' });
  R.claudeEvent(c, { type: 'assistant', message: { model: 'claude-opus-exact' } });
  R.claudeEvent(c, { type: 'result', modelUsage: { 'claude-sonnet-exact': {}, 'claude-haiku-exact': {} } });
  assert.deepEqual(c.models, ['claude-sonnet-exact', 'claude-opus-exact', 'claude-haiku-exact']);
  const root = join(scratch, 'sessions'), dir = join(root, '2026', '11', '21');
  mkdirSync(dir, { recursive: true });
  const session = [{ type: 'session_meta', payload: { id: 'abc', cwd: '/repo' } },
    { type: 'turn_context', payload: { cwd: '/repo', model: 'older', effort: 'low' } },
    { type: 'turn_context', payload: { cwd: '/repo', model: 'newer', effort: 'medium' } }];
  writeFileSync(join(dir, 'rollout-date-abc.jsonl'), session.map(JSON.stringify).join('\n'));
  assert.deepEqual(R.sessionInfo('abc', '/repo', root), { models: ['newer'], effort: 'medium' });
  assert.deepEqual(R.sessionModels('abc', '/other-repo', root), []);
  assert.deepEqual(R.sessionModels('../abc', '/repo', root), []);
});

test('version and status answer from installation metadata without claiming remote freshness', () => {
  const r = router(null, { execFileSync: (_bin, args) => ({ 'rev-parse': 'abc123', branch: 'main', status: '' })[args[0]] });
  const report = r.versionMarkdown('/repo', { version: '0.3.1', commit: 'build123' });
  assert.match(report, /Fuseway 0.3.1/);
  assert.match(report, /Installed build: build123/);
  assert.match(report, /main at abc123/);
  assert.match(report, /Remote freshness: not checked/);
  assert.match(r.statusMarkdown('/repo'), /requested-local/);
});

test('moving on and backend comparison do not teach success or failure', () => {
  const L = learner(), prev = { decisionId: 'd', backend: 'local' };
  assert.equal(L.outcomeFromNextTurn(prev, 'What next?'), null);
  assert.equal(L.outcomeFromNextTurn(prev, 'Review it', 'codex'), null);
  assert.equal(L.outcomeFromNextTurn(prev, 'that worked!'), 'success');
  const events = [{ type: 'decision', id: 'd', ts: Date.now(), local: true, routers: { a: 'local' } },
    { type: 'outcome', id: 'd', outcome: 'success', reason: 'next message' }];
  assert.equal(L.decisions(events)[0].label, null);
  assert.equal(L.labelFor({ escalated: true, local: false }, undefined), null);
});

test('background replay uses full saved context and ignores legacy truncated decisions', async () => {
  const L = learner();
  const context = R.routingSnapshot({ prompt: 'x'.repeat(800), turns: [{ user: 'prior question', meta: { backend: 'local' } }],
    files: [{ path: 'test.js', bytes: 10 }], rules: { ...R.loadRules(), maxLocalFiles: 5 }, localContext: 9999 });
  L.append({ type: 'decision', id: 'old', prompt: 'truncated', localModel: 'q', routers: {} });
  L.append({ type: 'decision', id: 'new', prompt: context.prompt, context, localModel: 'q', routers: { 'cascade@q': 'local' } });
  let input;
  await L.tick({ classifyWith: async (_name, ctx) => { input = ctx; return { tier: 'local', ms: 1, paidTokens: 0 }; },
    localModel: 'q', offline: () => false, budget: 0, maxJobs: 1,
    ctx: () => assert.fail('live context must not replace the saved snapshot') });
  assert.equal(input.prompt.length, 800);
  assert.equal(input.turns[0].user, 'prior question');
  assert.equal(input.files[0].path, 'test.js');
  assert.equal(input.rules.maxLocalFiles, 5);
  assert.equal(input.localContext, 9999);
  assert.equal(L.load().filter((e) => e.type === 'router' && e.id === 'old').length, 0);
});

test('in-flight background work receives cancellation and records no interrupted result', async () => {
  const L = learner(), ac = new AbortController();
  let called = false;
  await L.tick({ classifyWith: async (_name, ctx) => { called = true; assert.equal(ctx.signal, ac.signal); ac.abort(); throw new Error('interrupted'); },
    localModel: 'q', offline: () => false, budget: 0, signal: ac.signal });
  assert.equal(called, true);
  assert.equal(L.load().length, 0);
});

test('model calls are visible before feedback and success uses only judged calls', () => {
  const L = learner(), ts = Date.now();
  const events = [{ type: 'agent', attempt: 'a', agent: 'codex:actual:medium:agent', ts, in: 10, out: 2, ms: 40 },
    { type: 'agent', attempt: 'b', agent: 'codex:actual:medium:agent', ts, in: 20, out: 4, ms: 60 }];
  let score = L.agentScores(events)['codex:actual:medium:agent'];
  assert.equal(score.n, 2); assert.equal(score.judged, 0); assert.equal(score.success, null);
  events.push({ type: 'agent', attempt: 'a', agent: 'codex:actual:medium:agent', ts, outcome: 'success', explicit: true });
  score = L.agentScores(events)['codex:actual:medium:agent'];
  assert.equal(score.n, 2); assert.equal(score.judged, 1); assert.equal(score.success, 1);
  assert.equal(score.tokensPerCall, 18);
  assert.match(L.statsMarkdown(events, 'q'), /codex:actual:medium:agent/);
});

function extensionHarness({ classify, run, history = [], command, prompt = 'Write a docstring' } = {}) {
  let callback, timer, cancel;
  const events = [], replies = [], calls = [];
  const config = { get: (key, fallback) => key === 'learning.enabled' ? true : fallback };
  const vscode = {
    workspace: { getConfiguration: () => config, workspaceFolders: [{ uri: { fsPath: '/repo' } }], asRelativePath: () => 'file.js' },
    window: { createOutputChannel: () => ({ appendLine() {}, append() {}, show() {} }), setStatusBarMessage() {} },
    chat: { createChatParticipant: (_id, cb) => { callback = cb; return { onDidReceiveFeedback() {} }; } },
    commands: { registerCommand: () => ({}) },
    ChatRequestTurn: class {}, ChatResponseTurn: class {}, Uri: class {}, ChatResultFeedbackKind: { Helpful: 1 },
  };
  const L = { POLICY: { defaultRouter: 'cascade' }, load: () => [], currentRouter: () => ({ key: 'cascade@q' }), routerName: () => 'cascade',
    routerKey: (name) => `${name}@q`, newId: (() => { let n = 0; return () => String(++n); })(), append: (e) => events.push(e),
    outcomeFromNextTurn: () => null, reconsider: () => ({ switched: false }), tick: async () => {}, statsMarkdown: () => '' };
  const r = { ...R, localConfig: () => ({ model: 'q' }), readLimits: () => ({}),
    classifyWith: classify || (async (_name, ctx) => { calls.push(['classify', ctx]); return { tier: 'local', trail: ['test route'], paidTokens: 0, localTokens: 4, ms: 1 }; }),
    run: run || (async (backend, opts) => { calls.push(['run', backend, opts]); return { text: 'done', sessionId: null, model: 'exact-model', effort: 'medium', inTok: 20, outTok: 3, ms: 2 }; }),
    versionMarkdown: () => 'installed build', statusMarkdown: () => 'configured model' };
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', '[]'); child.emit('close', 0); }); return child;
  };
  const extension = load('extension/extension.js', { vscode, './router': r, './learner': L, child_process: { spawn } }, {
    setTimeout: (fn) => { timer = fn; return 1; }, clearTimeout: () => {},
  });
  extension.activate({ subscriptions: [], globalState: { get: () => false } });
  const token = { isCancellationRequested: false, onCancellationRequested: (fn) => { cancel = () => { token.isCancellationRequested = true; fn(); }; return { dispose() {} }; } };
  const execute = () => callback({ command, prompt, references: [] }, { history }, { markdown: (value) => replies.push(value), progress() {} }, token);
  return { execute, cancel: () => cancel(), events, replies, calls, getTimer: () => timer, learner: L };
}

test('chat version bypasses agents; completed calls and actual model appear without feedback', async () => {
  const version = extensionHarness({ command: 'version' });
  await version.execute();
  assert.deepEqual(version.replies, ['installed build']);
  assert.equal(version.calls.length, 0);
  const chat = extensionHarness();
  await chat.execute();
  assert.match(chat.replies.join(''), /Local model \(exact-model · medium effort\)/);
  assert.equal(chat.events.filter((e) => e.type === 'agent').length, 1);
  const decision = chat.events.find((e) => e.type === 'decision');
  assert.equal(decision.context.prompt, 'Write a docstring');
  const task = chat.events.find((e) => e.type === 'task');
  assert.equal(task.completed, true);
  assert.equal(task.localTokens, 27, 'includes local classifier and execution');
});

test('chat cancellation during routing does not execute an agent', async () => {
  let ctx, entered;
  const routing = new Promise((resolve) => { entered = resolve; });
  const chat = extensionHarness({ classify: async (_name, input) => {
    ctx = input;
    entered();
    return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('cancelled'))));
  } });
  const request = chat.execute();
  await routing;
  chat.cancel();
  await request;
  assert.equal(ctx.signal.aborted, true);
  assert.equal(chat.calls.filter((c) => c[0] === 'run').length, 0);
  assert.match(chat.replies.join(''), /cancelled/);
});

test('incoming chat cancels in-flight background inference', async () => {
  const chat = extensionHarness();
  await chat.execute();
  let backgroundSignal;
  chat.learner.tick = async ({ signal }) => {
    backgroundSignal = signal;
    return new Promise((done) => signal.addEventListener('abort', done));
  };
  const pending = chat.getTimer()();
  await chat.execute();
  await pending;
  assert.equal(backgroundSignal.aborted, true);
});

test('CLI execution reports actual session model and effort instead of requested defaults', async () => {
  const calls = [];
  const spawn = (bin, args) => {
    calls.push(args);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('close', 143);
    queueMicrotask(() => {
      const events = args[0] === 'exec' ? [
        { type: 'thread.started', thread_id: 'abc' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'completed' } },
        { type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 2 } },
      ] : [
        { type: 'system', model: 'claude-actual', session_id: 'c1' },
        { type: 'assistant', message: { model: 'claude-second' } },
        { type: 'result', result: 'completed', usage: { input_tokens: 20, output_tokens: 3 } },
      ];
      child.stdout.emit('data', events.map(JSON.stringify).join('\n') + '\n');
      child.emit('close', 0);
    });
    return child;
  };
  const r = router(null, { spawn });
  const codex = await r.run('codex', { prompt: 'a task', cwd: '/repo', codexEffort: 'high', codexModel: 'requested-frontier' });
  assert.equal(codex.model, 'newer');
  assert.equal(codex.effort, 'medium');
  assert.equal(codex.requestedEffort, 'high');
  assert.equal(codex.requestedModel, 'requested-frontier');
  assert.equal(calls[0][calls[0].indexOf('--model') + 1], 'requested-frontier');
  const claude = await r.run('claude', { prompt: 'a task', cwd: '/repo', claudeModel: 'sonnet' });
  assert.equal(claude.model, 'claude-actual + claude-second');
  assert.equal(claude.requestedModel, 'sonnet');
  const local = await r.run('local', { prompt: 'a task', cwd: '/repo', localModel: 'selected-company-local', localEffort: 'high' });
  assert.equal(local.requestedModel, 'selected-company-local');
  assert.equal(local.requestedEffort, 'high');
  assert.equal(calls[2][calls[2].indexOf('--model') + 1], 'selected-company-local');
  assert.ok(calls[2].includes('model_reasoning_effort="high"'));
  assert.ok(calls[2].includes('local'));
  assert.match(r.usageMarkdown(), /codex:newer:medium:agent/);
  assert.match(r.usageMarkdown(), /claude:claude-actual \+ claude-second:agent/);
});
