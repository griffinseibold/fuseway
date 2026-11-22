// @fuseway: a chat participant that gives each request a role (roles.js) and picks a backend for it: by role in
// roles mode, or the cheapest capable one, local model first, in local-first mode (router.js).
// The VSIX also carries the fuseway CLI (bin/fuseway.mjs), run with VS Code's own Node, for setup commands.
const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const r = require('./router');
const L = require('./learner');
const Ro = require('./roles');

const FORCED = ['local', 'claude', 'codex', 'grok'];
const ROOT = fs.existsSync(path.join(__dirname, 'bin', 'fuseway.mjs')) ? __dirname : path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'fuseway.mjs');
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
let output;

function turnsFrom(history) {
  const turns = [];
  for (const h of history) {
    if (h instanceof vscode.ChatRequestTurn) turns.push({ user: h.prompt });
    else if (h instanceof vscode.ChatResponseTurn && turns.length) {
      const t = turns[turns.length - 1];
      t.meta = h.result?.metadata;
      t.assistant = h.response.map((p) => p.value?.value ?? '').join('');
    }
  }
  return turns;
}

const MIME_EXT = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'text/plain': '.txt' };

// Returns { path (repo-relative, for routing), abs (for the backend to open), bytes } per user attachment.
// Uploaded or pasted attachments arrive as bytes, not files, so they're saved to a temp folder first.
async function attachedFiles(request) {
  const files = [];
  let dir;
  for (const [i, ref] of (request.references || []).entries()) {
    // VS Code attaches the repo's instruction files (AGENTS.md, copilot-instructions.md…) to every request.
    // They aren't the user's attachments, and the backends read them on their own.
    if (/^vscode\.(instructions|prompt)/.test(ref.id || '') || /^prompt:/.test(ref.name || '')) continue;
    const v = ref.value;
    // VS Code's reference shapes vary by how a file was attached; log each so a dropped one can be diagnosed.
    output?.appendLine(`Fuseway attachment: id=${ref.id} name=${ref.name} value=${v?.constructor?.name || typeof v} scheme=${v?.scheme || v?.uri?.scheme || '-'} mime=${v?.mimeType || '-'}`);
    if (v && typeof v.data === 'function' && typeof v.mimeType === 'string') {
      try {
        const bytes = Buffer.from(await v.data());
        dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'fuseway-attachments-'));
        const base = path.basename(String(ref.name || `attachment-${i + 1}`)).replace(/[^\w.@ -]/g, '_') || `attachment-${i + 1}`;
        const name = path.extname(base) ? base : base + (MIME_EXT[v.mimeType] || '');
        const abs = path.join(dir, name);
        fs.writeFileSync(abs, bytes);
        files.push({ path: abs, abs, bytes: bytes.length });
      } catch {}
      continue;
    }
    const uri = v instanceof vscode.Uri ? v : v?.uri;
    if (!uri || uri.scheme !== 'file') continue;
    let bytes = 0;
    try { bytes = fs.statSync(uri.fsPath).size; } catch {}
    // vscode.implicit.* is the file open in the editor, sent with every request: context, not an attachment.
    files.push({ path: vscode.workspace.asRelativePath(uri, false), abs: uri.fsPath, bytes, ...(/^vscode\.implicit/.test(ref.id || '') && { open: true }) });
  }
  return files;
}

// What VS Code passed in, without contents, at .fuseway/debug/last-request.json in the workspace, so any agent
// (which can read only the workspace) can see which build ran and how each attachment arrived.
function writeRequestDebug(cwd, request, files) {
  const shape = (ref) => {
    const v = ref.value;
    const uri = v instanceof vscode.Uri ? v : v?.uri;
    return { id: ref.id, name: ref.name, modelDescription: ref.modelDescription, range: ref.range,
      valueType: v?.constructor?.name || typeof v, valueKeys: v && typeof v === 'object' ? Object.keys(v) : undefined,
      scheme: uri?.scheme, path: uri?.fsPath || uri?.path, mimeType: v?.mimeType };
  };
  try {
    const dir = path.join(cwd, '.fuseway', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'last-request.json'), JSON.stringify({ ts: new Date().toISOString(), build: installedBuild,
      vscodeVersion: vscode.version, requestKeys: Object.keys(request), command: request.command, promptChars: request.prompt?.length,
      references: (request.references || []).map(shape), toolReferences: (request.toolReferences || []).map((t) => ({ name: t.name, range: t.range })),
      attached: files.map((f) => ({ path: f.path, abs: f.abs, bytes: f.bytes })) }, null, 2) + '\n');
  } catch {}
}

const agentKey =(backend, res) => [backend, res.model || 'unknown', res.effort, res.execution || 'agent'].filter(Boolean).join(':');
let busy = 0;
let backgroundController;
const installedBuild = (() => { try { return require('./build-info.json'); } catch { return {}; } })();

function resolvePrevious(prev, prompt, command) {
  const outcome = L.outcomeFromNextTurn(prev, prompt, command);
  if (!outcome) return;
  if (prev.decisionId) L.append({ type: 'outcome', id: prev.decisionId, outcome, reason: 'next message', verifiedSignal: true });
  if (prev.attempt) L.append({ type: 'agent', ...prev.attempt, outcome, verifiedSignal: true });
}

async function handle(request, context, stream, token) {
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) controller.abort();
  try { return await handleRequest(request, context, stream, controller.signal); }
  finally { subscription.dispose(); }
}

async function handleRequest(request, context, stream, signal) {
  const started = Date.now();
  const c = vscode.workspace.getConfiguration('fuseway');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  signal.throwIfAborted();
  if (request.command === 'company') {
    const { command } = await import(require('node:url').pathToFileURL(path.join(ROOT, 'company', 'cli.mjs')).href);
    const input = request.prompt.trim();
    const split = input.indexOf(' ');
    const subcommand = !input ? 'status' : split < 0 ? input : input.slice(0, split);
    const argument = split < 0 ? undefined : input.slice(split + 1).trim();
    stream.markdown('```json\n' + await command(cwd, subcommand, argument, { signal, onProgress: message => stream.progress(message) }) + '\n```');
    return {};
  }
  if (request.command === 'version') { stream.markdown(r.versionMarkdown(cwd, installedBuild)); return {}; }
  if (request.command === 'status') { stream.markdown(r.statusMarkdown(cwd, installedBuild)); return {}; }
  if (request.command === 'usage') { stream.markdown(r.usageMarkdown()); return {}; }
  const local = r.localConfig();
  if (request.command === 'stats') { stream.markdown(L.statsMarkdown(L.load(), local?.model)); return {}; }

  const mode = Ro.routingMode(c.get('routing', 'auto'), !!local);
  const learning = c.get('learning.enabled', true);
  const turns = turnsFrom(context.history);
  if (learning) resolvePrevious(turns.at(-1)?.meta, request.prompt, request.command);
  const forced = FORCED.includes(request.command);
  const frontier = (prefer = c.get('frontier', 'balance')) => r.pickFrontier(r.readLimits(), prefer, Date.now(),
    { claude: c.get('claudeReserve', 0.2), codex: c.get('codexReserve', 0) });
  const files = await attachedFiles(request);
  writeRequestDebug(cwd, request, files);
  signal.throwIfAborted();
  const routingContext = r.routingSnapshot({ prompt: request.prompt, turns, files: files.filter((f) => !f.open).map((f) => ({ path: f.path, bytes: f.bytes })),
    localContext: local?.contextWindow, rules: r.loadRules(cwd) });
  const picked = Ro.pickRole(request.prompt, { roles: Ro.loadRoles(cwd), command: request.command, turns });
  const role = picked.role;
  let prompt = Ro.roleNote(role) + request.prompt + r.attachmentNote(files);
  let backend, trail, router, route, decision = null;
  if (forced) {
    backend = request.command;
    trail = [`/${request.command}`];
  } else if (mode === 'roles') {
    const pick = Ro.pickBackend(role, { limits: r.readLimits(), installed: r.installed(), frontier: c.get('frontier', 'balance'),
      reserve: { claude: c.get('claudeReserve', 0.2), codex: c.get('codexReserve', 0) }, files: files.filter((f) => !f.open), stay: picked.stay });
    backend = pick.backend;
    trail = [pick.why];
  } else {
    stream.progress('Routing…');
    router = L.currentRouter(L.load(), local?.model).key;
    const name = L.routerName(router);
    route = await r.classifyWith(name, { ...routingContext, signal });
    signal.throwIfAborted();
    trail = name === L.POLICY.defaultRouter ? route.trail : [`decided by ${router}`, ...route.trail];
    if (route.tier === 'local') backend = 'local';
    else if (route.backend) backend = route.backend;
    else { const pick = frontier(); backend = pick.backend; trail.push(pick.why); }
    if (learning && !route.structural && route.tier !== 'same' && !r.offline(route)) {
      const routers = { [router]: route.tier };
      for (const [n, t] of Object.entries(r.freeShadows(name, route))) routers[L.routerKey(n, local?.model)] = t;
      decision = { id: L.newId(), prompt: request.prompt, context: routingContext, localModel: local?.model,
        routers, cost: { [router]: { tokens: route.paidTokens, ms: route.ms } } };
    }
  }
  trail.unshift(`role: ${role.name} (${picked.why})`);
  // A matching skill adds its playbook to the prompt; one that needs a frontier model raises a local route.
  const skill = r.matchSkill(request.prompt, cwd);
  if (skill) {
    trail.push(`skill: ${skill.skill} ("${skill.phrase}")`);
    if (!forced && backend === 'local' && skill.route === 'frontier') { const pick = frontier(); backend = pick.backend; trail.push(`${skill.skill} needs a frontier model`, pick.why); }
    prompt += r.skillNote(skill);
  }

  const attempts = [];
  const attempt = async (b) => {
    const execution = b === 'local' ? r.localExecution(routingContext) : 'agent';
    stream.progress(`${r.LABELS[b]} is working…`);
    const p = execution === 'direct' ? { prompt } : r.plan(turns, b, prompt);
    try {
      const res = await r.run(b, { ...p, execution, cwd, addDirs: r.attachmentDirs(files, cwd), claudeModel: c.get('claudeModel', 'sonnet'),
        codexEffort: c.get('codexEffort', 'medium'), codexModel: c.get('codexModel', ''), grokModel: c.get('grokModel', ''), signal, onProgress: (m) => stream.progress(m),
        // The role turns edits off for read-only work and, in roles mode, picks the model.
        ...Ro.roleOptions(role, b, { allowEdits: c.get('allowEdits', true) }, { models: mode === 'roles' }) });
      signal.throwIfAborted();
      if (!res.text?.trim()) throw Object.assign(new r.BackendError('empty reply', false), { result: res, ms: res.ms });
      res.execution = execution;
      attempts.push({ attempt: L.newId(), backend: b, agent: agentKey(b, res), ok: true, usageIncomplete: res.usageIncomplete, in: res.inTok, out: res.outTok, ms: res.ms, quota: res.quota || 0 });
      return res;
    } catch (e) {
      if (signal.aborted) throw new r.BackendError('cancelled', false);
      attempts.push({ attempt: L.newId(), backend: b, agent: agentKey(b, { ...e.result, execution }), ok: false, usageIncomplete: e.result?.usageIncomplete, in: e.result?.inTok, out: e.result?.outTok, ms: e.ms || 0, reason: e.message.slice(0, 120) });
      throw e;
    }
  };

  let res, escalated = false;
  try {
    try { res = await attempt(backend); }
    catch (e) {
      if (forced || signal.aborted || e.message === 'cancelled') throw e;
      const next = backend === 'local' ? frontier().backend : e.limited ? backend === 'grok' ? frontier('balance').backend : { claude: 'codex', codex: 'claude' }[backend] : null;
      if (!next || (mode === 'roles' && next !== 'grok' && !r.installed()[next])) throw e;
      trail.push(backend === 'local' ? `local model ${r.failureReason(e.message)} → ${r.LABELS[next]}` : `${r.LABELS[backend]} hit its limit → ${r.LABELS[next]}`);
      escalated = backend === 'local';
      backend = next;
      res = await attempt(backend);
    }
  } finally {
    if (learning && !signal.aborted) {
      for (const a of attempts) L.append({ type: 'agent', ...a, infrastructure: !a.ok });
      L.append({ type: 'task', router, id: decision?.id, ms: Date.now() - started, attempts, escalated, completed: !!res, usageIncomplete: attempts.some((a) => a.usageIncomplete || (!a.ok && a.in === undefined)),
        paidTokens: (route?.paidTokens || 0) + attempts.filter((a) => a.backend !== 'local').reduce((sum, a) => sum + (a.in || 0) + (a.out || 0), 0),
        localTokens: (route?.localTokens || 0) + attempts.filter((a) => a.backend === 'local').reduce((sum, a) => sum + (a.in || 0) + (a.out || 0), 0),
        quota: attempts.reduce((sum, a) => sum + (a.quota || 0), 0) });
    }
  }
  const attemptInfo = { attempt: attempts.at(-1).attempt, agent: agentKey(backend, res), usageIncomplete: res.usageIncomplete, in: res.inTok, out: res.outTok, ms: res.ms, quota: res.quota || 0 };
  if (decision) {
    L.append({ type: 'decision', ...decision, local: backend === 'local', served: attemptInfo.agent });
  }
  stream.markdown(res.text);
  // The agent has exited by now; say so, so a reply that ends mid-plan isn't read as work still running.
  const stopped = r.unfinished(res.text);
  if (stopped) stream.markdown(`\n\n> **Stopped before finishing.** ${r.LABELS[backend]} ended its run while saying it would do more. No agent is still working on this. Reply \`continue\` to pick it back up.`);
  const model = res.model === 'unknown' && res.requestedModel ? `unknown; requested ${res.requestedModel}` : r.displayModel(res.model);
  stream.markdown(`\n\n---\n*${stopped ? 'Stopped early' : 'Done'}, no agent still working · ${r.LABELS[backend]} (${model}${res.effort ? ` · ${res.effort} effort` : res.requestedEffort ? ` · requested ${res.requestedEffort} effort` : ''}) · ${res.execution} · ${res.inTok === undefined ? 'unknown' : k(res.inTok)} in / ${res.outTok === undefined ? 'unknown' : k(res.outTok)} out${res.usageIncomplete ? ' · usage incomplete' : ''} · ${trail.join(' → ')}*`);
  return { metadata: { backend, role: role.id, sessionId: res.sessionId, model: res.model, decisionId: decision?.id, attempt: learning ? attemptInfo : undefined } };
}

// The background learner: after a turn, when nothing else is running, fill in other routers' answers and test
// thin candidates (paid ones within a daily token budget), then reconsider who decides. Quiet: it only says
// something in the status bar when the decision maker changes.
let learnTimer = null, learning = false;
function reconsider() {
  const pick = L.reconsider(r.localConfig()?.model);
  if (pick.switched) {
    output.appendLine(`Fuseway: decision maker is now ${pick.key} (${pick.reason})`);
    vscode.window.setStatusBarMessage(`Fuseway: decision maker is now ${pick.key}`, 15_000);
  }
}
function learnSoon() {
  const c = vscode.workspace.getConfiguration('fuseway');
  // Roles mode has no router to score, and the learner's paid tests would spend quota nobody asked for.
  if (!c.get('learning.enabled', true) || Ro.routingMode(c.get('routing', 'auto'), !!r.localConfig()) !== 'local-first') return;
  clearTimeout(learnTimer);
  learnTimer = setTimeout(async () => {
    if (busy || learning) return learnSoon();
    learning = true;
    backgroundController = new AbortController();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const local = r.localConfig();
    try {
      await L.tick({ classifyWith: r.classifyWith, offline: r.offline, localModel: local?.model, budget: c.get('learning.dailyPaidTokens', 20_000),
        ctx: (prompt) => ({ prompt, rules: r.loadRules(cwd), localContext: local?.contextWindow }), isBusy: () => busy > 0, signal: backgroundController.signal });
      reconsider();
    } catch (e) { output.appendLine(`Fuseway learner: ${e.message}`); }
    finally { learning = false; }
  }, 5_000);
}

// Runs the bundled fuseway CLI with VS Code's own Node, so setup needs no separate install.
function cli(args, { show = true } = {}) {
  return new Promise((resolve) => {
    if (show) { output.show(true); output.appendLine(`$ fuseway ${args.join(' ')}`); }
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let out = '';
    const take = (d) => { out += d; if (show) output.append(String(d)); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => { if (show) output.appendLine(''); resolve({ code, out }); });
  });
}

// Runs setup commands where the user can watch and answer prompts. "fuseway …" means the bundled CLI, run with
// VS Code's own Node (ELECTRON_RUN_AS_NODE makes the VS Code binary behave as Node; it doesn't affect claude or codex).
function inTerminal(commands) {
  const self = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath}" "${CLI}"`;
  const term = vscode.window.createTerminal({ name: 'Fuseway setup', env: { ELECTRON_RUN_AS_NODE: '1' } });
  term.show();
  for (const c of commands) term.sendText(c.replace(/^fuseway\b/, self));
}

async function startupCheck(ctx) {
  if (ctx.globalState.get('fuseway.quietSetup')) return;
  const { out } = await cli(['doctor', '--json'], { show: false });
  let results = [];
  try { results = JSON.parse(out); } catch { return; }
  const todo = results.filter((x) => !x.ok && !x.optional);
  if (!todo.length) return;
  const runnable = [...new Set(todo.map((x) => x.run).filter(Boolean))];
  const pick = await vscode.window.showWarningMessage(`Fuseway: ${todo.map((x) => x.name).join(', ')} need${todo.length === 1 ? 's' : ''} setting up.`,
    ...(runnable.length ? ['Set Up'] : []), 'Show Details', "Don't Ask Again");
  if (pick === "Don't Ask Again") return ctx.globalState.update('fuseway.quietSetup', true);
  if (pick === 'Set Up') return inTerminal([...runnable, 'fuseway doctor']);
  if (pick) await cli(['doctor']);
}

exports.activate = (ctx) => {
  output = vscode.window.createOutputChannel('Fuseway');
  const id = require('./package.json').contributes.chatParticipants[0].id;
  const participant = vscode.chat.createChatParticipant(id, async (request, context, stream, token) => {
    backgroundController?.abort();
    clearTimeout(learnTimer);
    busy++;
    try {
      return await handle(request, context, stream, token);
    } catch (e) {
      stream.markdown(`**fuseway:** ${token.isCancellationRequested ? 'cancelled' : e.message}`);
      return { errorDetails: { message: e.message } };
    } finally {
      busy--;
      learnSoon();
    }
  });
  participant.onDidReceiveFeedback((e) => {
    const m = e.result?.metadata;
    if (!m?.attempt && !m?.decisionId) return;
    const outcome = e.kind === vscode.ChatResultFeedbackKind.Helpful ? 'success' : 'fail';
    if (m.decisionId) L.append({ type: 'outcome', id: m.decisionId, outcome, explicit: true, reason: 'feedback' });
    if (m.attempt) L.append({ type: 'agent', ...m.attempt, outcome, explicit: true });
    reconsider();
  });
  const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  ctx.subscriptions.push(participant, output,
    vscode.commands.registerCommand('fuseway.checkSetup', () => cli(['doctor'])),
    vscode.commands.registerCommand('fuseway.setUpModel', () => inTerminal(['fuseway model --install'])),
    vscode.commands.registerCommand('fuseway.addToRepo', async () => {
      if (!folder()) return vscode.window.showErrorMessage('Fuseway: open a folder first.');
      const pick = await vscode.window.showQuickPick([
        { label: 'pstack', description: 'engineering playbooks, bundled (default)', value: 'pstack' },
        { label: 'Superpowers', description: 'obra/superpowers, downloaded from GitHub', value: 'superpowers' },
        { label: 'No skills', description: 'just the instructions, context cache and fusion', value: 'none' }], { title: 'Fuseway: which skills?' });
      if (pick) await cli(['init', folder(), '--skills', pick.value]);
    }));
  startupCheck(ctx);
};
