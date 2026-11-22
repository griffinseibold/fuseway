import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const R = require('../extension/router.js');
function load(file, overrides = {}, globals = {}) {
  const filename = resolve(file), module = { exports: {} }, localRequire = createRequire(filename);
  runInNewContext(readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: (id) => overrides[id] || localRequire(id), __dirname: resolve(file, '..'),
    process, Buffer, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, ...globals }, { filename });
  return module.exports;
}

function chat(references, classify) {
  let callback;
  const calls = [];
  class Uri { constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; } }
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }), workspaceFolders: [{ uri: { fsPath: '/repo' } }],
      asRelativePath: (uri) => uri.fsPath.startsWith('/repo/') ? uri.fsPath.slice(6) : uri.fsPath },
    window: { createOutputChannel: () => ({ appendLine() {}, append() {}, show() {} }), setStatusBarMessage() {} },
    chat: { createChatParticipant: (_id, cb) => { callback = cb; return { onDidReceiveFeedback() {} }; } },
    commands: { registerCommand: () => ({}) }, ChatRequestTurn: class {}, ChatResponseTurn: class {}, Uri, ChatResultFeedbackKind: { Helpful: 1 },
  };
  const L = { POLICY: { defaultRouter: 'cascade' }, load: () => [], currentRouter: () => ({ key: 'cascade@q' }), routerName: () => 'cascade', routerKey: (n) => `${n}@q`,
    append() {}, outcomeFromNextTurn: () => null, newId: () => 'id', reconsider: () => ({ switched: false }), tick: async () => {} };
  const r = { ...R, localConfig: () => ({ model: 'q' }), readLimits: () => ({}),
    classifyWith: classify || (async (_name, ctx) => ({ ...(R.applyRules(ctx) || { tier: 'local', trail: [] }), ms: 1 })),
    run: async (backend, opts) => { calls.push({ backend, opts }); return { text: 'done', model: 'm', inTok: 1, outTok: 1, ms: 1 }; } };
  const extension = load('extension/extension.js', { vscode, './router': r, './learner': L }, { setTimeout: () => 1, clearTimeout() {} });
  extension.activate({ subscriptions: [], globalState: { get: () => true } });
  const execute = () => callback({ prompt: 'what does this say?', references: references(Uri) }, { history: [] }, { markdown() {}, progress() {} },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  return { execute, calls };
}

test('an uploaded PDF is saved, named in the prompt, readable by Claude, and routed to Claude', async () => {
  const pdf = Buffer.from('%PDF-1.4 test');
  const c = chat(() => [{ id: 'upload', name: 'feedback.pdf', value: { mimeType: 'application/pdf', data: async () => new Uint8Array(pdf) } }]);
  await c.execute();
  assert.equal(c.calls.length, 1);
  const { backend, opts } = c.calls[0];
  assert.equal(backend, 'claude');
  const saved = /- (\/\S+feedback\.pdf) \(1 KB\)/.exec(opts.prompt)?.[1];
  assert.ok(saved, opts.prompt);
  assert.deepEqual(readFileSync(saved), pdf);
  assert.deepEqual(opts.addDirs, [dirname(saved)]);
  assert.match(opts.prompt, /^You are the Explainer\.[^\n]*\n\nRequest: what does this say\?\n\nThe user attached this file/);
});

test('workspace files are named by absolute path without extra directories; instruction files are skipped', async () => {
  const c = chat((Uri) => [
    { id: 'vscode.instructions.agents', name: 'AGENTS.md', value: new Uri('/repo/AGENTS.md') },
    { id: 'file', name: 'a.js', value: new Uri('/repo/src/a.js') },
  ]);
  await c.execute();
  const { opts } = c.calls[0];
  assert.match(opts.prompt, /- \/repo\/src\/a\.js/);
  assert.doesNotMatch(opts.prompt, /AGENTS\.md/);
  assert.deepEqual(opts.addDirs, []);
});

test('the file open in the editor is mentioned, not attached, and does not count for routing', async () => {
  // Shape recorded from VS Code 1.146: the PDF the user attached plus the editor's active file.
  let seen;
  const c = chat((Uri) => [
    { id: 'file:///home/u/Downloads/Agensi%20x%20Griffin.pdf', name: 'Agensi x Griffin.pdf', value: new Uri('/home/u/Downloads/Agensi x Griffin.pdf') },
    { id: 'vscode.implicit.file', name: 'file:settings.local.json', value: new Uri('/repo/.claude/settings.local.json') },
  ], async (_name, ctx) => { seen = ctx; return { ...(R.applyRules(ctx) || { tier: 'local', trail: [] }), ms: 1 }; });
  await c.execute();
  const { backend, opts } = c.calls[0];
  assert.equal(backend, 'claude');
  assert.deepEqual(seen.files.map((f) => f.path), ['/home/u/Downloads/Agensi x Griffin.pdf']);
  assert.match(opts.prompt, /attached this file\. Open and read it before answering:\n- \/home\/u\/Downloads\/Agensi x Griffin\.pdf/);
  assert.match(opts.prompt, /has \/repo\/\.claude\/settings\.local\.json open in the editor; read it only if/);
  assert.deepEqual([...opts.addDirs], ['/home/u/Downloads']);
});

test('no attachments adds nothing after the request', async () => {
  const c = chat(() => []);
  await c.execute();
  assert.match(c.calls[0].opts.prompt, /\n\nRequest: what does this say\?$/);
});

test('PDF and image rule pins Claude; text files keep normal routing', () => {
  assert.equal(R.applyRules({ prompt: 'x', files: [{ path: 'docs/spec.PDF', bytes: 10 }] }).backend, 'claude');
  assert.equal(R.applyRules({ prompt: 'x', files: [{ path: 'shot.png', bytes: 10 }] }).backend, 'claude');
  assert.equal(R.applyRules({ prompt: 'x', files: [{ path: 'a.js', bytes: 10 }] }), null);
});

test('Claude receives --add-dir for each attachment directory', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fuseway-attach-'));
  const calls = [];
  const { EventEmitter } = await import('node:events');
  const spawn = (bin, args) => {
    calls.push(args);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
  const r = load('extension/router.js', { child_process: { spawn } }, { process: { ...process, env: { ...process.env, CLAUDE_BIN: '/bin/claude', FUSEWAY_STATE_DIR: scratch } } });
  await r.run('claude', { prompt: 'p', cwd: '/repo', addDirs: ['/tmp/a', '/tmp/b'] });
  const args = calls[0];
  assert.deepEqual([...args].flatMap((a, i) => a === '--add-dir' ? [args[i + 1]] : []), ['/tmp/a', '/tmp/b']);
});
