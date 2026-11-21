import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const R = require('../extension/router.js');

function repoWith(skills, routing) {
  const root = mkdtempSync(join(tmpdir(), 'fuseway-skills-'));
  mkdirSync(join(root, '.agents'));
  for (const s of skills) { mkdirSync(join(root, '.agents/skills', s), { recursive: true }); writeFileSync(join(root, '.agents/skills', s, 'SKILL.md'), `# ${s}\n`); }
  if (routing) writeFileSync(join(root, '.agents/routing.json'), JSON.stringify(routing));
  return root;
}

test('a phrase picks its installed skill and names the file to follow', () => {
  const root = repoWith(['interrogate']);
  const m = R.matchSkill('Can I get a second opinion on this plan?', root);
  assert.equal(m.skill, 'interrogate');
  assert.equal(m.route, 'frontier');
  assert.match(R.skillNote(m), /`interrogate` skill\. Read \.agents\/skills\/interrogate\/SKILL\.md and follow it/);
});

test('skills that are not installed, and unrelated prompts, match nothing', () => {
  assert.equal(R.matchSkill('Can I get a second opinion?', repoWith([])), null);
  assert.equal(R.matchSkill('rename this variable', repoWith(['interrogate', 'tdd'])), null);
  assert.equal(R.skillNote(null), '');
});

test('a repo can disable an entry and add its own', () => {
  const root = repoWith(['interrogate', 'deploy-runbook'], { disable: ['multi-model-review'],
    skills: [{ id: 'deploy', skill: 'deploy-runbook', phrases: ['ship it to prod'] }] });
  assert.equal(R.matchSkill('second opinion please', root), null);
  assert.equal(R.matchSkill('ship it to prod tonight', root).skill, 'deploy-runbook');
});

test('skill names cannot point outside .agents/skills', () => {
  const root = repoWith([], { skills: [{ id: 'x', skill: '../../etc', phrases: ['anything'] }] });
  assert.equal(R.matchSkill('anything', root), null);
});

test('every catalog entry is well formed and names a bundled or vendored skill', () => {
  const { skills } = JSON.parse(readFileSync('extension/skills.json', 'utf8'));
  const vendored = [...readFileSync('scripts/vendor-skills.mjs', 'utf8').matchAll(/name: '([\w-]+)'/g)].map((m) => m[1]);
  const ids = new Set();
  for (const s of skills) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`); ids.add(s.id);
    assert.ok(s.phrases.length && s.phrases.every((p) => typeof p === 'string' && p.trim()), s.id);
    assert.ok(['frontier', undefined].includes(s.route), s.id);
    assert.ok(existsSync(join('.agents/skills', s.skill, 'SKILL.md')) || vendored.includes(s.skill), `${s.skill} is neither bundled nor vendored`);
  }
});

function load(file, overrides = {}, globals = {}) {
  const filename = resolve(file), module = { exports: {} }, localRequire = createRequire(filename);
  runInNewContext(readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: (id) => overrides[id] || localRequire(id), __dirname: resolve(file, '..'),
    process, Buffer, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, ...globals }, { filename });
  return module.exports;
}

async function chat(root, { command, tier = 'local' } = {}) {
  let callback;
  const calls = [];
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }), workspaceFolders: [{ uri: { fsPath: root } }], asRelativePath: (u) => u.fsPath },
    window: { createOutputChannel: () => ({ appendLine() {}, append() {}, show() {} }), setStatusBarMessage() {} },
    chat: { createChatParticipant: (_id, cb) => { callback = cb; return { onDidReceiveFeedback() {} }; } },
    commands: { registerCommand: () => ({}) }, ChatRequestTurn: class {}, ChatResponseTurn: class {}, Uri: class {}, ChatResultFeedbackKind: { Helpful: 1 },
  };
  const L = { POLICY: { defaultRouter: 'cascade' }, load: () => [], currentRouter: () => ({ key: 'cascade@q' }), routerName: () => 'cascade', routerKey: (n) => `${n}@q`,
    append() {}, outcomeFromNextTurn: () => null, newId: () => 'id', reconsider: () => ({ switched: false }), tick: async () => {} };
  const r = { ...R, localConfig: () => ({ model: 'q' }), readLimits: () => ({}),
    classifyWith: async () => ({ tier, trail: [], ms: 1 }),
    run: async (backend, opts) => { calls.push({ backend, opts }); return { text: 'done', model: 'm', inTok: 1, outTok: 1, ms: 1 }; } };
  const extension = load('extension/extension.js', { vscode, './router': r, './learner': L }, { setTimeout: () => 1, clearTimeout() {} });
  extension.activate({ subscriptions: [], globalState: { get: () => true } });
  const replies = [];
  await callback({ command, prompt: 'give me a second opinion on this design', references: [] }, { history: [] }, { markdown: (s) => replies.push(s), progress() {} },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  return { calls, reply: replies.join('') };
}

test('a frontier skill raises a local route and its playbook reaches the agent', async () => {
  const { calls, reply } = await chat(repoWith(['interrogate']));
  assert.equal(calls[0].backend, 'claude');
  assert.match(calls[0].opts.prompt, /follow it\.$/);
  assert.match(reply, /skill: interrogate/);
});

test('a forced backend keeps its choice but still gets the skill', async () => {
  const { calls } = await chat(repoWith(['interrogate']), { command: 'local' });
  assert.equal(calls[0].backend, 'local');
  assert.match(calls[0].opts.prompt, /interrogate/);
});

test('without the skill installed, routing and prompt are unchanged', async () => {
  const { calls } = await chat(repoWith([]));
  assert.equal(calls[0].backend, 'local');
  assert.equal(calls[0].opts.prompt, 'give me a second opinion on this design');
});
