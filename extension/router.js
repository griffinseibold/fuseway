// Routing and backends for the @loadout chat participant. No vscode imports, so node --test can run it.
//
// Per request: deterministic rules decide what they can (applyRules). Otherwise Qwen classifies LOCAL or FRONTIER (free, ~0.3 s). LOCAL is final. FRONTIER goes to Haiku to
// confirm (~1K tokens), because Qwen over-escalates. Frontier work goes to whichever of Claude and Codex has
// more of its 5-hour window left, from the utilization both CLIs report. All three backends are agent CLIs
// that read and edit the workspace themselves: Codex on the local model, Claude Code, and Codex.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE = path.join(os.homedir(), '.local', 'state', 'loadout');
const USAGE_LOG = path.join(STATE, 'usage.jsonl');
const CLAUDE_LIMITS = path.join(STATE, 'claude-limits.json');
const LOCAL_CONFIG = path.join(os.homedir(), '.config', 'loadout', 'local.json');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
const LIMIT_ERROR = /usage limit|rate limit|limit reached|quota|\b429\b/i;

const LABELS = { local: 'Local model', claude: 'Claude', codex: 'Codex' };
const ROUTER_SYSTEM = 'You route coding requests. Reply with exactly one word.\n' +
  'LOCAL: a small model can do it: mechanical, single-file or self-contained, drafting, summarizing, formatting, boilerplate, simple tests, docs.\n' +
  'FRONTIER: needs a strong model: design or architecture, non-obvious debugging, multi-file or cross-service changes, security, concurrency, anything where a wrong answer is costly.';

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
function which(name, fallbacks = []) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  return fallbacks.find((f) => fs.existsSync(f)) || name;
}
const CLAUDE = process.env.CLAUDE_BIN || which('claude');
const CODEX = process.env.CODEX_BIN || which('codex', ['/usr/lib/chatgpt/resources/codex']);

class BackendError extends Error {
  constructor(message, limited) { super(message); this.limited = limited; }
}

// ---------- routing ----------

function routerInput(prompt, previousPrompt) {
  return previousPrompt ? `Previous request in this chat: ${previousPrompt.slice(0, 500)}\n\nNew request: ${prompt}` : prompt;
}

async function askQwen(input) {
  const local = readJson(LOCAL_CONFIG, null);
  if (!local) throw new Error('no local model configured (run `loadout model`)');
  const res = await fetch(`${local.url}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ model: local.model, max_tokens: 5, temperature: 0, grammar: 'root ::= "LOCAL" | "FRONTIER"',
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'system', content: ROUTER_SYSTEM }, { role: 'user', content: input }] }),
  });
  if (!res.ok) throw new Error(`local model HTTP ${res.status}`);
  const r = await res.json();
  return { label: r.choices[0].message.content.includes('FRONTIER') ? 'FRONTIER' : 'LOCAL', tokens: r.usage?.total_tokens || 0 };
}

async function askHaiku(input) {
  // Run outside any repo with a one-line system prompt and no tools: ~1K tokens instead of ~38K.
  const cwd = path.join(os.tmpdir(), 'loadout-router');
  fs.mkdirSync(cwd, { recursive: true });
  const { out } = await spawnCli(CLAUDE, ['-p', input, '--model', 'haiku', '--system-prompt', ROUTER_SYSTEM, '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--disable-slash-commands',
    '--output-format', 'stream-json', '--verbose'], { cwd });
  const s = out.split('\n').filter(Boolean).map(safeJson).reduce(claudeEvent, claudeState());
  if (s.error) throw new BackendError(`haiku: ${s.error}`, LIMIT_ERROR.test(s.error));
  return { label: /FRONTIER/i.test(s.text) ? 'FRONTIER' : 'LOCAL', tokens: s.inTok + s.outTok };
}

// ---------- deterministic rules ----------
// Checked in order before any model is asked; the first match decides. A repo can extend them in
// .agents/routing.json (lists are added to these, numbers replace them).
const DEFAULT_RULES = {
  // Mistakes here are costly or need deep reasoning. Matched as word prefixes: "migrat" matches "migration".
  frontierKeywords: ['security', 'vulnerab', 'authenticat', 'authoriz', 'oauth', 'login', 'sso', 'password', 'secret',
    'credential', 'api key', 'access token', 'encrypt', 'crypto', 'permission', 'injection', 'xss', 'csrf', 'cve', 'sanitiz',
    'architect', 'design', 'migrat', 'race condition', 'deadlock', 'concurren', 'thread-safe', 'memory leak', 'scalab',
    'production', 'incident', 'outage', 'data loss', 'root cause', 'intermittent', 'flaky'],
  // Small, mechanical jobs. Only applies to short requests with no frontier keyword.
  localKeywords: ['docstring', 'jsdoc', 'comment', 'rename', 'typo', 'spelling', 'format', 'gitignore', 'commit message',
    'changelog', 'summarize', 'summary', 'convert', 'boilerplate', 'readme', 'lint'],
  frontierPaths: [], // globs, e.g. "src/billing/**": any attached file there goes frontier
  maxLocalShare: 0.5, // prompt + attached files above this share of the local context window go frontier
  localAttempts: 2, // after this many local turns in a row, a "that didn't work" message goes frontier
  followUpChars: 300, // a message this short right after a frontier turn stays with that backend
  maxLocalChars: 2000, // local keywords only count for requests shorter than this
  maxLocalFiles: 2, // more attached files than this goes frontier
};
const FAILURE = /(didn'?t|doesn'?t|does not|did not) work|not working|still (fail|broken|wrong|not)|is wrong|\bbroke|got an? (error|exception)|traceback|stack trace|tests? (fail|still)/i;

function loadRules(repoDir) {
  const repo = repoDir ? readJson(path.join(repoDir, '.agents', 'routing.json'), {}) : {};
  const out = { ...DEFAULT_RULES };
  for (const [k, v] of Object.entries(repo)) {
    if (!(k in DEFAULT_RULES)) continue;
    out[k] = Array.isArray(DEFAULT_RULES[k]) ? [...DEFAULT_RULES[k], ...(Array.isArray(v) ? v : [])] : typeof v === 'number' ? v : DEFAULT_RULES[k];
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keyword = (list, text) => list.find((w) => new RegExp(`\\b${escapeRe(w)}`, 'i').test(text));
const globRe = (g) => new RegExp(`^${g.split('**').map((part) => part.split('*').map(escapeRe).join('[^/]*')).join('.*')}$`);
const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

// ctx: { prompt, turns: [{ user, meta: { backend } }], files: [{ path (repo-relative), bytes }], localContext, rules }
// Returns { tier: 'local' | 'frontier' | 'same', backend?, trail } when a rule decides, else null.
function applyRules({ prompt, turns = [], files = [], localContext = 32768, rules = DEFAULT_RULES }) {
  const decide = (tier, why, backend) => ({ tier, backend, trail: [`rule: ${why}`] });
  const prev = turns.at(-1)?.meta?.backend;
  if ((prev === 'claude' || prev === 'codex') && prompt.length <= rules.followUpChars && !keyword(rules.localKeywords, prompt))
    return decide('same', `short follow-up stays with ${LABELS[prev]}`, prev);
  let streak = 0;
  for (let i = turns.length - 1; i >= 0 && turns[i].meta?.backend === 'local'; i--) streak++;
  if (streak >= rules.localAttempts && FAILURE.test(prompt)) return decide('frontier', `local model tried ${streak} times`);
  const tokens = Math.ceil((prompt.length + files.reduce((sum, f) => sum + (f.bytes || 0), 0)) / 4);
  if (tokens > rules.maxLocalShare * localContext)
    return decide('frontier', `~${kTokens(tokens)} tokens is over ${Math.round(rules.maxLocalShare * 100)}% of the local context`);
  const pinned = files.find((f) => rules.frontierPaths.some((g) => globRe(g).test(f.path)));
  if (pinned) return decide('frontier', `${pinned.path} is on this repo's frontier list`);
  const hard = keyword(rules.frontierKeywords, prompt);
  if (hard) return decide('frontier', `mentions "${hard}"`);
  if (files.length > rules.maxLocalFiles) return decide('frontier', `${files.length} files attached`);
  const easy = keyword(rules.localKeywords, prompt);
  if (easy && prompt.length < rules.maxLocalChars) return decide('local', `"${easy}" task`);
  return null;
}

// Rules first; then Qwen; LOCAL is final; FRONTIER is checked by Haiku. Never throws: when in doubt, frontier.
async function classify(ctx, deps = { qwen: askQwen, haiku: askHaiku, log: appendUsage }) {
  const ruled = applyRules(ctx);
  if (ruled) return ruled;
  const input = routerInput(ctx.prompt, ctx.turns?.at(-1)?.user);
  let q;
  try {
    q = await deps.qwen(input);
    deps.log({ backend: 'router-qwen', ok: true, in: q.tokens, out: 0 });
  } catch (e) {
    // With the local model down, local work has nowhere to run, so there is nothing to ask Haiku.
    return { tier: 'frontier', trail: [`local model offline (${e.message})`] };
  }
  if (q.label === 'LOCAL') return { tier: 'local', trail: ['Qwen: LOCAL'] };
  try {
    const h = await deps.haiku(input);
    deps.log({ backend: 'router-haiku', ok: true, in: h.tokens, out: 0 });
    return { tier: h.label === 'LOCAL' ? 'local' : 'frontier', trail: ['Qwen: FRONTIER', `Haiku: ${h.label}`] };
  } catch (e) {
    return { tier: 'frontier', trail: ['Qwen: FRONTIER', `Haiku failed (${e.message})`] };
  }
}

// ---------- usage limits ----------

// limits: { claude?: Window, codex?: Window }, Window = { used: 0..1, resetsAt: epoch seconds, blocked: bool }
function headroom(w, now) {
  if (!w || w.resetsAt * 1000 < now) return 1;
  return w.blocked ? 0 : 1 - w.used;
}

function pickFrontier(limits, prefer = 'balance', now = Date.now()) {
  const left = { claude: headroom(limits.claude, now), codex: headroom(limits.codex, now) };
  const current = (k) => limits[k] && limits[k].resetsAt * 1000 >= now;
  const pct = (k) => (current(k) ? `${Math.round(left[k] * 100)}%` : 'no current reading');
  const why = `5h left: Claude ${pct('claude')}, Codex ${pct('codex')}`;
  const open = ['claude', 'codex'].filter((k) => left[k] > 0.05);
  if (prefer !== 'balance' && open.includes(prefer)) return { backend: prefer, why: `${why}; preferred` };
  const pool = open.length ? open : ['claude', 'codex'];
  const backend = pool.reduce((a, b) => (left[b] > left[a] ? b : a));
  return { backend, why: open.length ? why : `${why}; both nearly out` };
}

function claudeWindow(info) {
  const w = info?.unifiedWindows?.five_hour;
  return w ? { used: w.utilization, resetsAt: w.resetsAt, blocked: w.status !== 'allowed', weekUsed: info.unifiedWindows.seven_day?.utilization } : null;
}

function codexWindow(rl) {
  if (!rl?.primary) return null;
  return { used: rl.primary.used_percent / 100, resetsAt: rl.primary.resets_at, blocked: !!rl.rate_limit_reached_type, weekUsed: rl.secondary ? rl.secondary.used_percent / 100 : undefined };
}

function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) { const f = findKey(v, key); if (f !== undefined) return f; }
  return undefined;
}

// Codex writes its rate limits into each session file; read the newest one that has them.
function readCodexLimits() {
  const files = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => b.name.localeCompare(a.name)).slice(0, depth === 3 ? 50 : 3)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(CODEX_SESSIONS, 0);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files.slice(0, 20)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"rate_limits"')).reverse();
    for (const l of lines) { const w = codexWindow(findKey(safeJson(l), 'rate_limits')); if (w) return w; }
  }
  return null;
}

function readLimits() {
  return { claude: readJson(CLAUDE_LIMITS, null), codex: readCodexLimits() };
}

// ---------- backends ----------

function safeJson(line) { try { return JSON.parse(line); } catch { return {}; } }

function describeTool(name, input = {}) {
  if (input.command) return `Running \`${String(input.command).slice(0, 80)}\``;
  if (input.file_path) return `${name} ${path.basename(input.file_path)}`;
  return name;
}

const claudeState = () => ({ text: '', sessionId: null, inTok: 0, outTok: 0, costUsd: 0, error: null, limits: null, progress: [] });
function claudeEvent(s, e) {
  if (e.type === 'system' && e.session_id) s.sessionId = e.session_id;
  if (e.type === 'rate_limit_event') s.limits = claudeWindow(e.rate_limit_info) || s.limits;
  if (e.type === 'assistant') for (const b of e.message?.content || []) if (b.type === 'tool_use') s.progress.push(describeTool(b.name, b.input));
  if (e.type === 'result') {
    s.sessionId = e.session_id || s.sessionId;
    s.text = e.result || '';
    const u = e.usage || {};
    s.inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    s.outTok = u.output_tokens || 0;
    s.costUsd = e.total_cost_usd || 0;
    if (e.is_error) s.error = e.result || e.subtype || 'error';
  }
  return s;
}

const codexState = () => ({ text: '', sessionId: null, inTok: 0, outTok: 0, error: null, progress: [] });
function codexEvent(s, e) {
  if (e.type === 'thread.started') s.sessionId = e.thread_id;
  if (e.type === 'item.started' && e.item?.type === 'command_execution') s.progress.push(describeTool('Bash', { command: e.item.command }));
  if (e.type === 'item.completed' && e.item?.type === 'file_change') s.progress.push(`Edited ${(e.item.changes || []).map((c) => path.basename(c.path)).join(', ') || 'files'}`);
  if (e.type === 'item.completed' && e.item?.type === 'agent_message') s.text = e.item.text;
  if (e.type === 'turn.completed') { s.inTok += e.usage?.input_tokens || 0; s.outTok += e.usage?.output_tokens || 0; }
  if (e.type === 'error' || e.type === 'turn.failed') s.error = e.message || e.error?.message || 'error';
  return s;
}

function spawnCli(bin, args, { cwd, signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, FUSION_CHILD: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', buf = '';
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort);
    child.stdout.on('data', (d) => {
      out += d; buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) if (l.trim()) onLine?.(safeJson(l));
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new BackendError(`${bin}: ${e.message}`, false)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (buf.trim()) onLine?.(safeJson(buf));
      if (signal?.aborted) return reject(new BackendError('cancelled', false));
      resolve({ code, out, err });
    });
  });
}

// opts: { prompt, cwd, sessionId, allowEdits, claudeModel, codexEffort, onProgress, signal }
// Returns { text, sessionId, model, inTok, outTok }; throws BackendError (with .limited) on failure.
async function run(backend, opts) {
  const start = Date.now();
  const entry = { backend, ok: false };
  try {
    const r = backend === 'claude' ? await runClaude(opts) : await runCodex(backend, opts);
    Object.assign(entry, { ok: true, model: r.model, in: r.inTok, out: r.outTok, cost_usd: r.costUsd });
    return r;
  } catch (e) {
    Object.assign(entry, { error: e.message.slice(0, 300), limited: !!e.limited });
    throw e;
  } finally {
    entry.ms = Date.now() - start;
    appendUsage(entry);
  }
}

async function runClaude({ prompt, cwd, sessionId, allowEdits, claudeModel = 'sonnet', onProgress, signal }) {
  const s = claudeState();
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', claudeModel,
    '--permission-mode', allowEdits ? 'acceptEdits' : 'plan', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ...(sessionId ? ['--resume', sessionId] : [])];
  const { code, err } = await spawnCli(CLAUDE, args, { cwd, signal, onLine: (e) => {
    const before = s.progress.length;
    claudeEvent(s, e);
    for (const p of s.progress.slice(before)) onProgress?.(p);
  } });
  if (s.limits) { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(CLAUDE_LIMITS, JSON.stringify(s.limits)); }
  const error = s.error || (code !== 0 && !s.text ? err.slice(-500) || `exited ${code}` : null);
  if (error) throw new BackendError(`Claude: ${error}`, LIMIT_ERROR.test(error) || !!s.limits?.blocked);
  return { text: s.text, sessionId: s.sessionId, model: `claude-${claudeModel}`, inTok: s.inTok, outTok: s.outTok, costUsd: s.costUsd };
}

async function runCodex(backend, { prompt, cwd, sessionId, allowEdits, codexEffort = 'medium', onProgress, signal }) {
  const s = codexState();
  const local = backend === 'local' ? readJson(LOCAL_CONFIG, null) : null;
  if (backend === 'local' && !local) throw new BackendError('No local model configured: run `loadout model`.', false);
  // Options go before `resume`: the resume subcommand has no --profile or --sandbox of its own.
  const args = ['exec', ...(local ? ['--profile', 'local'] : ['-c', `model_reasoning_effort="${codexEffort}"`]),
    '--json', '--skip-git-repo-check', '--sandbox', allowEdits ? 'workspace-write' : 'read-only',
    ...(sessionId ? ['resume', sessionId] : []), prompt];
  const { code, err } = await spawnCli(CODEX, args, { cwd, signal, onLine: (e) => {
    const before = s.progress.length;
    codexEvent(s, e);
    for (const p of s.progress.slice(before)) onProgress?.(p);
  } });
  const error = s.error || (code !== 0 ? err.split('\n').filter((l) => !/models_manager/.test(l)).join('\n').slice(-500) || `exited ${code}` : null);
  if (error) {
    const offline = local && /connect|refused|unreachable|error sending request/i.test(error);
    throw new BackendError(offline ? `Local model offline at ${local.url}. Start it (homelab: ./scripts/lab-mode.py llm --wait) or rerun without /local.` : `${LABELS[backend]}: ${error}`, LIMIT_ERROR.test(error));
  }
  return { text: s.text, sessionId: s.sessionId, model: local ? local.model : 'codex', inTok: s.inTok, outTok: s.outTok };
}

// ---------- conversation ----------

// turns: [{ user, assistant, meta: { backend, sessionId } }], oldest first, not including the current request.
// Resume the backend's own session when it has one, and hand over whatever other backends said since.
function plan(turns, backend, prompt) {
  let last = -1;
  turns.forEach((t, i) => { if (t.meta?.backend === backend && t.meta.sessionId) last = i; });
  const sessionId = last >= 0 ? turns[last].meta.sessionId : null;
  const missed = turns.slice(last + 1).slice(-3);
  if (!missed.length) return { sessionId, prompt };
  const clip = (s) => (s && s.length > 1500 ? `${s.slice(0, 1500)}…` : s || '');
  const history = missed.map((t) => `User: ${clip(t.user)}\nAssistant (${LABELS[t.meta?.backend] || 'another model'}): ${clip(t.assistant)}`).join('\n\n');
  return { sessionId, prompt: `Earlier in this conversation, handled by other models:\n\n${history}\n\nCurrent request: ${prompt}` };
}

// ---------- usage log ----------

function appendUsage(entry) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(USAGE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

function usageMarkdown(hours = 5, now = Date.now()) {
  const rows = {};
  let lines = [];
  try { lines = fs.readFileSync(USAGE_LOG, 'utf8').split('\n').filter(Boolean); } catch {}
  for (const l of lines) {
    const e = safeJson(l);
    if (!e.ts || now - Date.parse(e.ts) > hours * 3_600_000) continue;
    const r = (rows[e.backend] ||= { calls: 0, failed: 0, in: 0, out: 0 });
    r.calls++; r.failed += e.ok ? 0 : 1; r.in += e.in || 0; r.out += e.out || 0;
  }
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
  const limits = readLimits();
  const win = (w) => (!w ? 'no reading yet' : w.resetsAt * 1000 < now ? 'no current reading (the last window has reset)' : `${Math.round(w.used * 100)}% of 5h used (resets ${new Date(w.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})${w.weekUsed !== undefined ? `, ${Math.round(w.weekUsed * 100)}% of week` : ''}`);
  return [`**Subscription windows**`, `- Claude: ${win(limits.claude)}`, `- Codex: ${win(limits.codex)}`, '',
    `**loadout calls, last ${hours} h**`, '', '| | calls | failed | tokens in | tokens out |', '|---|---|---|---|---|',
    ...Object.entries(rows).map(([b, r]) => `| ${b} | ${r.calls} | ${r.failed} | ${k(r.in)} | ${k(r.out)} |`)].join('\n');
}

const localConfig = () => readJson(LOCAL_CONFIG, null);

module.exports = { localConfig, LABELS, DEFAULT_RULES, loadRules, applyRules, classify, pickFrontier, readLimits, run, plan, usageMarkdown, claudeEvent, claudeState, codexEvent, codexState, claudeWindow, codexWindow, askQwen, askHaiku, BackendError };
