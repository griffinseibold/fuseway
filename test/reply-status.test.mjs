import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const R = require('../extension/router.js');

test('a reply that ends on a promise is unfinished', () => {
  // Both from real local-model replies that stopped mid-task.
  assert.equal(R.unfinished("Let me add temporary debug logging to understand what's happening in init."), true);
  assert.equal(R.unfinished('Still one test file failing. Let me debug what\'s going on with `fuseway.test.mjs`.'), true);
  assert.equal(R.unfinished('Tests pass.\n\nNext, I\'ll commit the changes.'), true);
  assert.equal(R.unfinished('Here is the plan:'), true);
  assert.equal(R.unfinished('All 93 tests pass and the release is published.'), false);
  assert.equal(R.unfinished('Done. Let me know if you want the release cut too.'), false, 'a closing offer is finished');
  assert.equal(R.unfinished('I\'ll explain why below.\n\nThe cache was stale, so the old build ran.'), false, 'only the end counts');
});

test('combined assents stay with the backend that proposed the work', () => {
  const turns = [{ user: 'commit and release?', assistant: 'Shall I commit?', meta: { backend: 'claude', sessionId: 's' } }];
  for (const p of ['okay do that', 'yes, go ahead', 'ok', 'sure do it']) assert.equal(R.applyRules({ prompt: p, turns })?.backend, 'claude', p);
  assert.equal(R.applyRules({ prompt: 'okay now write the docs for the router', turns }), null);
});

test('a local context overflow reads as such, not as a cut-off server error', () => {
  // The real error, as llama-server returned it through Codex.
  const raw = 'Local model: {"error":{"code":400,"message":"request (65578 tokens) exceeds the available context size (65536 tokens), try increasing it","type":"exceed_context_size_error"}}';
  assert.equal(R.failureReason(raw), 'ran out of context at 66K tokens');
  assert.equal(R.failureReason('connection refused'), 'connection refused');
  assert.equal(R.failureReason('x'.repeat(100)).length, 78);
});

test('the main model comes first and helper models are labeled', () => {
  assert.equal(R.displayModel('claude-opus-5-5 + claude-haiku-5-5 + claude-sonnet-5-5'), 'claude-opus-5-5; helpers used claude-haiku-5-5, claude-sonnet-5-5');
  assert.equal(R.displayModel('qwen'), 'qwen');
});

test('the local model starts fresh with recent turns instead of resuming its own session', () => {
  const turns = [
    { user: 'okay do that', assistant: 'Let me debug.', meta: { backend: 'local', sessionId: 'huge' } },
    { user: 'are we set?', assistant: 'Still failing.', meta: { backend: 'local', sessionId: 'huge' } },
  ];
  const p = R.plan(turns, 'local', 'is it clear?');
  assert.equal(p.sessionId, null);
  assert.match(p.prompt, /^Earlier in this conversation:\n\nUser: okay do that\nAssistant \(Local model\): Let me debug\./);
  assert.equal(R.plan(turns.map((t) => ({ ...t, meta: { backend: 'claude', sessionId: 'c1' } })), 'claude', 'next').sessionId, 'c1');
});

function load(file, overrides = {}, globals = {}) {
  const filename = resolve(file), module = { exports: {} }, localRequire = createRequire(filename);
  runInNewContext(readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: (id) => overrides[id] || localRequire(id), __dirname: resolve(file, '..'),
    process, Buffer, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, ...globals }, { filename });
  return module.exports;
}

async function reply(text) {
  let callback;
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }), workspaceFolders: [{ uri: { fsPath: '/nonexistent-repo' } }], asRelativePath: (u) => u.fsPath },
    window: { createOutputChannel: () => ({ appendLine() {}, append() {}, show() {} }), setStatusBarMessage() {} },
    chat: { createChatParticipant: (_id, cb) => { callback = cb; return { onDidReceiveFeedback() {} }; } },
    commands: { registerCommand: () => ({}) }, ChatRequestTurn: class {}, ChatResponseTurn: class {}, Uri: class {}, ChatResultFeedbackKind: { Helpful: 1 },
  };
  const L = { POLICY: { defaultRouter: 'cascade' }, load: () => [], currentRouter: () => ({ key: 'cascade@q' }), routerName: () => 'cascade', routerKey: (n) => `${n}@q`,
    append() {}, outcomeFromNextTurn: () => null, newId: () => 'id', reconsider: () => ({ switched: false }), tick: async () => {} };
  const r = { ...R, localConfig: () => ({ model: 'q' }), readLimits: () => ({}), classifyWith: async () => ({ tier: 'local', trail: [], ms: 1 }),
    run: async () => ({ text, model: 'qwen', inTok: 1, outTok: 1, ms: 1 }) };
  const extension = load('extension/extension.js', { vscode, './router': r, './learner': L }, { setTimeout: () => 1, clearTimeout() {} });
  extension.activate({ subscriptions: [], globalState: { get: () => true } });
  const out = [];
  await callback({ prompt: 'commit it', references: [] }, { history: [] }, { markdown: (s) => out.push(s), progress() {} },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  return out.join('');
}

test('every reply says whether the agent finished; a stopped one says nothing is still running', async () => {
  const stopped = await reply('Tests fail.\n\nLet me add temporary debug logging.');
  assert.match(stopped, /\*\*Stopped before finishing\.\*\* Local model ended its run .* No agent is still working on this\. Reply `continue`/);
  assert.match(stopped, /\*Stopped early, no agent still working · Local model/);
  const done = await reply('Committed as abc123.');
  assert.doesNotMatch(done, /Stopped/);
  assert.match(done, /\*Done, no agent still working · Local model/);
});
