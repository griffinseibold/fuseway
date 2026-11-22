import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const R = require('../extension/roles.js');
const role = (prompt, opts) => R.pickRole(prompt, opts).role.id;

test('phrases pick a role, the earliest match wins, and everything else builds', () => {
  assert.equal(role('Plan how we should split the billing module'), 'plan');
  assert.equal(role('Fix the bug where the design page crashes'), 'debug');
  assert.equal(role('Review my plan for the cache'), 'review');
  assert.equal(role('Why is the login test failing?'), 'debug');
  assert.equal(role('Add a dark mode toggle to settings'), 'build');
  assert.equal(role('add error handling to the parser'), 'build');
});

test('questions explain, unless they ask for a change', () => {
  assert.equal(role('How does the session cache get invalidated?'), 'explain');
  assert.equal(role('where is the retry logic'), 'explain');
  assert.equal(role('How do I add a button to the toolbar?'), 'build');
  assert.equal(role('what should I rename this to and can you rename it'), 'build');
});

test('a /role command wins over phrases', () => {
  const p = R.pickRole('fix the crash', { command: 'review' });
  assert.equal(p.role.id, 'review');
  assert.equal(p.why, '/review');
});

test('follow-ups keep the role and backend; a go-ahead after a read-only role builds on the same session', () => {
  const turns = [{ user: 'plan the cache', meta: { role: 'plan', backend: 'claude' } }];
  const go = R.pickRole('ok, go ahead', { turns });
  assert.deepEqual([go.role.id, go.stay], ['build', 'claude']);
  const more = R.pickRole('make it shorter', { turns });
  assert.deepEqual([more.role.id, more.stay], ['plan', 'claude']);
  assert.equal(role('now review the auth module', { turns }), 'review');
});

test('read-only roles turn edits off, and a user who turned edits off keeps them off', () => {
  const roles = R.loadRoles();
  const plan = roles.find((x) => x.id === 'plan'), build = roles.find((x) => x.id === 'build');
  assert.deepEqual(R.roleOptions(plan, 'claude', { allowEdits: true }), { allowEdits: false, claudeModel: 'opus' });
  assert.deepEqual(R.roleOptions(build, 'codex', { allowEdits: false }), { allowEdits: false, codexEffort: 'medium' });
  assert.deepEqual(R.roleOptions(plan, 'claude', { allowEdits: true }, { models: false }), { allowEdits: false });
  for (const r of roles) assert.ok(r.instructions.length > 40 && R.roleNote(r).endsWith('Request: '), r.id);
});

test('backends: role preference, then headroom, missing CLIs, attachments and follow-ups', () => {
  const roles = R.loadRoles();
  const debug = roles.find((x) => x.id === 'debug'), plan = roles.find((x) => x.id === 'plan');
  const now = Date.now(), soon = now / 1000 + 3600;
  assert.equal(R.pickBackend(debug, { now }).backend, 'codex');
  assert.equal(R.pickBackend(plan, { now }).backend, 'claude');
  // Codex nearly out: debug work moves to Claude.
  assert.equal(R.pickBackend(debug, { now, limits: { codex: { used: 0.99, resetsAt: soon } } }).backend, 'claude');
  assert.equal(R.pickBackend(debug, { now, installed: { claude: true, codex: false } }).backend, 'claude');
  assert.equal(R.pickBackend(plan, { now, frontier: 'codex' }).backend, 'codex');
  assert.equal(R.pickBackend(debug, { now, files: [{ path: 'shot.png' }] }).backend, 'claude');
  assert.equal(R.pickBackend(plan, { now, stay: 'codex' }).backend, 'codex');
  assert.throws(() => R.pickBackend(plan, { installed: {} }), /install and sign in/);
});

test('a repo changes a role field by field or adds one', () => {
  const root = mkdtempSync(join(tmpdir(), 'fuseway-roles-'));
  mkdirSync(join(root, '.agents'));
  writeFileSync(join(root, '.agents/routing.json'), JSON.stringify({ roles: [
    { id: 'plan', claudeModel: 'sonnet' },
    { id: 'docs', name: 'Writer', phrases: ['readme', 'changelog'], instructions: 'Write plain, short docs for this project.' }] }));
  const roles = R.loadRoles(root);
  assert.equal(roles.find((x) => x.id === 'plan').claudeModel, 'sonnet');
  assert.equal(roles.find((x) => x.id === 'plan').edits, false);
  assert.equal(R.pickRole('update the changelog', { roles }).role.id, 'docs');
  assert.equal(R.defaultRole(roles).id, 'build');
});

test('auto mode is roles until a local model is configured', () => {
  assert.equal(R.routingMode('auto', false), 'roles');
  assert.equal(R.routingMode('auto', true), 'local-first');
  assert.equal(R.routingMode('roles', true), 'roles');
});

// The real chat handler with a fake vscode, no local model configured, and both CLIs installed.
async function chatWithoutLocalModel(prompt, command) {
  let callback;
  const calls = [], shown = [];
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }), workspaceFolders: [{ uri: { fsPath: mkdtempSync(join(tmpdir(), 'fuseway-roles-chat-')) } }], asRelativePath: (u) => u.fsPath },
    window: { createOutputChannel: () => ({ appendLine() {}, append() {}, show() {} }), setStatusBarMessage() {} },
    chat: { createChatParticipant: (_id, cb) => { callback = cb; return { onDidReceiveFeedback() {} }; } },
    commands: { registerCommand: () => ({}) }, ChatRequestTurn: class {}, ChatResponseTurn: class {}, Uri: class {}, ChatResultFeedbackKind: { Helpful: 1 },
  };
  const L = { ...require('../extension/learner.js'), append() {}, tick: async () => assert.fail('learner ran in roles mode') };
  const Rt = require('../extension/router.js');
  const r = { ...Rt, localConfig: () => null, readLimits: () => ({}), installed: () => ({ claude: true, codex: true }),
    classifyWith: async () => assert.fail('classifier ran in roles mode'),
    run: async (backend, opts) => { calls.push({ backend, opts }); return { text: 'done', model: 'm', inTok: 1, outTok: 1, ms: 1 }; } };
  const filename = resolve('extension/extension.js'), module = { exports: {} }, localRequire = createRequire(filename);
  const overrides = { vscode, './router': r, './learner': L };
  runInNewContext(readFileSync(filename, 'utf8'), { module, exports: module.exports, require: (id) => overrides[id] || localRequire(id), __dirname: resolve('extension'),
    process, Buffer, AbortController, AbortSignal, fetch, setTimeout: () => 1, clearTimeout() {} }, { filename });
  module.exports.activate({ subscriptions: [], globalState: { get: () => true } });
  const result = await callback({ prompt, command, references: [] }, { history: [] }, { markdown: (m) => shown.push(m), progress() {} },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  return { calls, shown: shown.join(''), result };
}

test('without a local model, the role picks the backend and model and the reply names the role', async () => {
  const plan = await chatWithoutLocalModel('plan the cache layer');
  assert.equal(plan.calls[0].backend, 'claude');
  assert.equal(plan.calls[0].opts.claudeModel, 'opus');
  assert.equal(plan.calls[0].opts.allowEdits, false);
  assert.match(plan.calls[0].opts.prompt, /^You are the Planner\./);
  assert.match(plan.shown, /role: Planner \("plan"\)/);
  assert.equal(plan.result.metadata.role, 'plan');
  const debug = await chatWithoutLocalModel('the export test is failing');
  assert.deepEqual([debug.calls[0].backend, debug.calls[0].opts.codexEffort, debug.calls[0].opts.allowEdits], ['codex', 'high', true]);
  const forced = await chatWithoutLocalModel('look at the parser', 'review');
  assert.deepEqual([forced.calls[0].backend, forced.calls[0].opts.allowEdits], ['codex', false]);
});
