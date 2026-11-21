// @loadout: a chat participant that picks the cheapest capable backend per request. Logic lives in router.js.
const vscode = require('vscode');
const os = require('os');
const r = require('./router');

const FORCED = ['local', 'claude', 'codex'];
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

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

async function handle(request, context, stream, token) {
  const c = vscode.workspace.getConfiguration('loadout');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  if (request.command === 'usage') { stream.markdown(r.usageMarkdown()); return {}; }

  const turns = turnsFrom(context.history);
  let backend, trail;
  if (FORCED.includes(request.command)) {
    backend = request.command;
    trail = [`/${request.command}`];
  } else {
    stream.progress('Routing…');
    const route = await r.classify(request.prompt, turns.at(-1)?.user);
    trail = route.trail;
    if (route.tier === 'local') backend = 'local';
    else {
      const pick = r.pickFrontier(r.readLimits(), c.get('frontier', 'balance'));
      backend = pick.backend;
      trail.push(pick.why);
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

  let res;
  try {
    res = await attempt(backend);
  } catch (e) {
    const other = { claude: 'codex', codex: 'claude' }[backend];
    if (!e.limited || !other || FORCED.includes(request.command)) throw e;
    trail.push(`${r.LABELS[backend]} hit its limit → ${r.LABELS[other]}`);
    backend = other;
    res = await attempt(backend);
  }
  stream.markdown(res.text || '_(no reply)_');
  stream.markdown(`\n\n---\n*${r.LABELS[backend]} (${res.model}) · ${k(res.inTok)} in / ${k(res.outTok)} out · ${trail.join(' → ')}*`);
  return { metadata: { backend, sessionId: res.sessionId, model: res.model } };
}

exports.activate = (ctx) => {
  const id = require('./package.json').contributes.chatParticipants[0].id;
  const participant = vscode.chat.createChatParticipant(id, async (request, context, stream, token) => {
    try {
      return await handle(request, context, stream, token);
    } catch (e) {
      stream.markdown(`**loadout:** ${e.message}`);
      return { errorDetails: { message: e.message } };
    }
  });
  ctx.subscriptions.push(participant);
};
