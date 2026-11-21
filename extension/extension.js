// @fuseway: a chat participant that picks the cheapest capable backend per request. Logic lives in router.js.
// The VSIX also carries the fuseway CLI (bin/fuseway.mjs), run with VS Code's own Node, for setup commands.
const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Fuseway was called loadout: move this machine's old config and state once, before router and learner read them.
for (const d of ['.config', path.join('.local', 'state')]) {
  const from = path.join(os.homedir(), d, 'loadout'), to = path.join(os.homedir(), d, 'fuseway');
  if (fs.existsSync(from) && !fs.existsSync(to)) { try { fs.renameSync(from, to); } catch {} }
}
const r = require('./router');
const L = require('./learner');

const FORCED = ['local', 'claude', 'codex'];
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

function attachedFiles(request) {
  const files = [];
  for (const ref of request.references || []) {
    // VS Code attaches the repo's instruction files (AGENTS.md, copilot-instructions.md…) to every request.
    // They aren't the user's attachments, and the backends read them on their own.
    if (/^vscode\.(instructions|prompt)/.test(ref.id || '') || /^prompt:/.test(ref.name || '')) continue;
    const uri = ref.value instanceof vscode.Uri ? ref.value : ref.value?.uri;
    if (!uri || uri.scheme !== 'file') continue;
    let bytes = 0;
    try { bytes = fs.statSync(uri.fsPath).size; } catch {}
    files.push({ path: vscode.workspace.asRelativePath(uri, false), bytes });
  }
  return files;
}

const agentKey = (backend, res, c) => (backend === 'local' ? `local:${res.model}` : backend === 'claude'
  ? `claude:${String(res.model).replace(/^claude-/, '')}` : `codex:${c.get('codexEffort', 'medium')}`);
let busy = 0;

// The previous answer in this chat is judged by this message: complaining or switching backends is a failure,
// moving on is a success. Thumbs up or down (onDidReceiveFeedback) overrides it.
function resolvePrevious(prev, prompt, command) {
  const outcome = L.outcomeFromNextTurn(prev, prompt, command);
  if (!outcome) return;
  if (prev.decisionId) L.append({ type: 'outcome', id: prev.decisionId, outcome, reason: 'next message' });
  if (prev.attempt) L.append({ type: 'agent', ...prev.attempt, outcome });
}

async function handle(request, context, stream, token) {
  const c = vscode.workspace.getConfiguration('fuseway');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  if (request.command === 'usage') { stream.markdown(r.usageMarkdown()); return {}; }
  const local = r.localConfig();
  if (request.command === 'stats') { stream.markdown(L.statsMarkdown(L.load(), local?.model)); return {}; }

  const learning = c.get('learning.enabled', true);
  const turns = turnsFrom(context.history);
  if (learning) resolvePrevious(turns.at(-1)?.meta, request.prompt, request.command);
  const forced = FORCED.includes(request.command);
  const frontier = () => r.pickFrontier(r.readLimits(), c.get('frontier', 'balance'), Date.now(),
    { claude: c.get('claudeReserve', 0.2), codex: c.get('codexReserve', 0) });
  let backend, trail, decision = null;
  if (forced) {
    backend = request.command;
    trail = [`/${request.command}`];
  } else {
    stream.progress('Routing…');
    const champ = L.currentRouter(L.load(), local?.model);
    const name = L.routerName(champ.key);
    const route = await r.classifyWith(name, { prompt: request.prompt, turns, files: attachedFiles(request),
      localContext: local?.contextWindow, rules: r.loadRules(cwd) });
    trail = name === L.POLICY.defaultRouter ? route.trail : [`decided by ${champ.key}`, ...route.trail];
    if (route.tier === 'local') backend = 'local';
    else if (route.tier === 'same') backend = route.backend;
    else { const pick = frontier(); backend = pick.backend; trail.push(pick.why); }
    // Only real routing choices teach the learner: not structural rules, follow-ups, or a local model that's down.
    if (learning && !route.structural && route.tier !== 'same' && !r.offline(route)) {
      const routers = { [champ.key]: route.tier };
      for (const [n, t] of Object.entries(r.freeShadows(name, route))) routers[L.routerKey(n, local?.model)] = t;
      decision = { id: L.newId(), prompt: request.prompt.slice(0, 300), routers, cost: { [champ.key]: { tokens: route.paidTokens, ms: route.ms } } };
    }
  }

  const ac = new AbortController();
  token.onCancellationRequested(() => ac.abort());
  const attempt = (b) => {
    stream.progress(`${r.LABELS[b]} is working…`);
    const p = r.plan(turns, b, request.prompt);
    return r.run(b, { ...p, cwd, allowEdits: c.get('allowEdits', true), claudeModel: c.get('claudeModel', 'sonnet'),
      codexEffort: c.get('codexEffort', 'medium'), signal: ac.signal, onProgress: (m) => stream.progress(m) });
  };

  let res, escalated = false;
  try {
    res = await attempt(backend);
    // A local run that comes back empty counts as a failure: escalate instead of showing nothing.
    if (backend === 'local' && !forced && !res.text?.trim()) throw new r.BackendError('empty reply', false);
  } catch (e) {
    if (learning && e.message !== 'cancelled') L.append({ type: 'agent', attempt: L.newId(), agent: agentKey(backend, res || { model: backend === 'local' ? local?.model : 'claude-' + c.get('claudeModel', 'sonnet') }, c), outcome: 'fail', reason: e.message.slice(0, 120) });
    if (forced || e.message === 'cancelled') throw e;
    const next = backend === 'local' ? frontier().backend : e.limited ? { claude: 'codex', codex: 'claude' }[backend] : null;
    if (!next) throw e;
    trail.push(backend === 'local' ? `local failed (${e.message.split('\n')[0].slice(0, 80)}) → ${r.LABELS[next]}` : `${r.LABELS[backend]} hit its limit → ${r.LABELS[next]}`);
    escalated = backend === 'local';
    backend = next;
    res = await attempt(backend);
  }
  const attemptInfo = { attempt: L.newId(), agent: agentKey(backend, res, c), in: res.inTok, out: res.outTok, ms: res.ms, quota: res.quota || 0 };
  if (decision) {
    L.append({ type: 'decision', ...decision, local: backend === 'local', served: attemptInfo.agent });
    if (escalated) L.append({ type: 'escalated', id: decision.id });
  }
  stream.markdown(res.text || '_(no reply)_');
  stream.markdown(`\n\n---\n*${r.LABELS[backend]} (${res.model}) · ${k(res.inTok)} in / ${k(res.outTok)} out · ${trail.join(' → ')}*`);
  return { metadata: { backend, sessionId: res.sessionId, model: res.model, decisionId: decision?.id, attempt: learning ? attemptInfo : undefined } };
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
  if (!c.get('learning.enabled', true)) return;
  clearTimeout(learnTimer);
  learnTimer = setTimeout(async () => {
    if (busy || learning) return learnSoon();
    learning = true;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const local = r.localConfig();
    try {
      await L.tick({ classifyWith: r.classifyWith, offline: r.offline, localModel: local?.model, budget: c.get('learning.dailyPaidTokens', 20_000),
        ctx: (prompt) => ({ prompt, rules: r.loadRules(cwd), localContext: local?.contextWindow }), isBusy: () => busy > 0 });
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
    busy++;
    try {
      return await handle(request, context, stream, token);
    } catch (e) {
      stream.markdown(`**fuseway:** ${e.message}`);
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
