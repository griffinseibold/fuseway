// @loadout: a chat participant that picks the cheapest capable backend per request. Logic lives in router.js.
// The VSIX also carries the loadout CLI (bin/loadout.mjs), run with VS Code's own Node, for setup commands.
const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const r = require('./router');

const FORCED = ['local', 'claude', 'codex'];
const ROOT = fs.existsSync(path.join(__dirname, 'bin', 'loadout.mjs')) ? __dirname : path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'loadout.mjs');
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

async function handle(request, context, stream, token) {
  const c = vscode.workspace.getConfiguration('loadout');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  if (request.command === 'usage') { stream.markdown(r.usageMarkdown()); return {}; }

  const turns = turnsFrom(context.history);
  const forced = FORCED.includes(request.command);
  const frontier = () => r.pickFrontier(r.readLimits(), c.get('frontier', 'balance'));
  let backend, trail;
  if (forced) {
    backend = request.command;
    trail = [`/${request.command}`];
  } else {
    stream.progress('Routing…');
    const local = r.localConfig();
    const route = await r.classify({ prompt: request.prompt, turns, files: attachedFiles(request),
      localContext: local?.contextWindow, rules: r.loadRules(cwd) });
    trail = route.trail;
    if (route.tier === 'local') backend = 'local';
    else if (route.tier === 'same') backend = route.backend;
    else { const pick = frontier(); backend = pick.backend; trail.push(pick.why); }
  }

  const ac = new AbortController();
  token.onCancellationRequested(() => ac.abort());
  const attempt = (b) => {
    stream.progress(`${r.LABELS[b]} is working…`);
    const p = r.plan(turns, b, request.prompt);
    return r.run(b, { ...p, cwd, allowEdits: c.get('allowEdits', true), claudeModel: c.get('claudeModel', 'sonnet'),
      codexEffort: c.get('codexEffort', 'medium'), signal: ac.signal, onProgress: (m) => stream.progress(m) });
  };

  let res;
  try {
    res = await attempt(backend);
    // A local run that comes back empty counts as a failure: escalate instead of showing nothing.
    if (backend === 'local' && !forced && !res.text?.trim()) throw new r.BackendError('empty reply', false);
  } catch (e) {
    if (forced || e.message === 'cancelled') throw e;
    const next = backend === 'local' ? frontier().backend : e.limited ? { claude: 'codex', codex: 'claude' }[backend] : null;
    if (!next) throw e;
    trail.push(backend === 'local' ? `local failed (${e.message.split('\n')[0].slice(0, 80)}) → ${r.LABELS[next]}` : `${r.LABELS[backend]} hit its limit → ${r.LABELS[next]}`);
    backend = next;
    res = await attempt(backend);
  }
  stream.markdown(res.text || '_(no reply)_');
  stream.markdown(`\n\n---\n*${r.LABELS[backend]} (${res.model}) · ${k(res.inTok)} in / ${k(res.outTok)} out · ${trail.join(' → ')}*`);
  return { metadata: { backend, sessionId: res.sessionId, model: res.model } };
}

// Runs the bundled loadout CLI with VS Code's own Node, so setup needs no separate install.
function cli(args, { show = true } = {}) {
  return new Promise((resolve) => {
    if (show) { output.show(true); output.appendLine(`$ loadout ${args.join(' ')}`); }
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let out = '';
    const take = (d) => { out += d; if (show) output.append(String(d)); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => { if (show) output.appendLine(''); resolve({ code, out }); });
  });
}

async function startupCheck(ctx) {
  if (ctx.globalState.get('loadout.quietSetup')) return;
  const { out } = await cli(['doctor', '--json'], { show: false });
  let results = [];
  try { results = JSON.parse(out); } catch { return; }
  const todo = results.filter((x) => !x.ok && !x.optional);
  if (!todo.length) return;
  const needsModel = todo.some((x) => /Local model|local profile/.test(x.name));
  const pick = await vscode.window.showWarningMessage(`Loadout: ${todo.map((x) => x.name).join(', ')} need${todo.length === 1 ? 's' : ''} setting up.`,
    ...(needsModel ? ['Set Up Local Model'] : []), 'Show Details', "Don't Ask Again");
  if (pick === "Don't Ask Again") return ctx.globalState.update('loadout.quietSetup', true);
  if (pick === 'Set Up Local Model') await cli(['model']);
  if (pick) await cli(['doctor']);
}

exports.activate = (ctx) => {
  output = vscode.window.createOutputChannel('Loadout');
  const id = require('./package.json').contributes.chatParticipants[0].id;
  const participant = vscode.chat.createChatParticipant(id, async (request, context, stream, token) => {
    try {
      return await handle(request, context, stream, token);
    } catch (e) {
      stream.markdown(`**loadout:** ${e.message}`);
      return { errorDetails: { message: e.message } };
    }
  });
  const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  ctx.subscriptions.push(participant, output,
    vscode.commands.registerCommand('loadout.checkSetup', () => cli(['doctor'])),
    vscode.commands.registerCommand('loadout.setUpModel', () => cli(['model'])),
    vscode.commands.registerCommand('loadout.addToRepo', async () => {
      if (!folder()) return vscode.window.showErrorMessage('Loadout: open a folder first.');
      await cli(['init', folder()]);
    }));
  startupCheck(ctx);
};
