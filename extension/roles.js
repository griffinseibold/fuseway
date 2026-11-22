// Roles for the @fuseway chat participant. No vscode imports, so node --test can run it.
//
// Every request gets a role from roles.json: how the agent should behave (instructions prepended to the prompt),
// whether it may edit, and, in roles mode, which Claude or OpenAI model does it. Picking one is free: an explicit
// /<role> command, a follow-up, then phrases; no model call.
const fs = require('fs');
const path = require('path');
const r = require('./router');

const CATALOG = path.join(__dirname, 'roles.json');
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const startsRe = (w) => new RegExp(`^\\W*${escapeRe(w)}(?![a-z0-9])`, 'i');
const ASSENT = /^(?:(?:yes|okay|ok|sure|go ahead|do (?:it|that)|sounds good|ship it|approved?)[,.! ]*)+$/i;

// .agents/routing.json "roles": an entry with a built-in id changes that role field by field; a new id adds one.
function loadRoles(repoDir) {
  const repo = repoDir ? readJson(path.join(repoDir, '.agents', 'routing.json'), {}) : {};
  const roles = readJson(CATALOG, { roles: [] }).roles.map((x) => ({ ...x }));
  for (const o of Array.isArray(repo.roles) ? repo.roles : []) {
    if (!o || !/^[\w-]+$/.test(o.id || '')) continue;
    const i = roles.findIndex((x) => x.id === o.id);
    if (i >= 0) roles[i] = { ...roles[i], ...o };
    else if (o.instructions) roles.splice(roles.length - 1, 0, { name: o.id, edits: true, prefer: 'balance', ...o });
  }
  return roles;
}

const defaultRole = (roles) => roles.find((x) => x.default) || roles.at(-1);

// Returns { role, why, stay? }. stay names the backend a follow-up should keep, so its session resumes.
function pickRole(prompt, { roles = loadRoles(), command, turns = [] } = {}) {
  const byId = (id) => roles.find((x) => x.id === id);
  if (command && byId(command)) return { role: byId(command), why: `/${command}` };
  const prev = turns.at(-1)?.meta;
  const text = prompt.trim();
  if (prev?.role && byId(prev.role) && text.length <= 300) {
    // "Go ahead" after a read-only role means do it: hand the same session to the default role.
    if (ASSENT.test(text) && !byId(prev.role).edits) return { role: defaultRole(roles), why: `go-ahead after ${byId(prev.role).name}`, stay: prev.backend };
    if (r.isContinuation(text)) return { role: byId(prev.role), why: 'follow-up', stay: prev.backend };
  }
  let best = null;
  for (const role of roles) {
    for (const p of role.phrases || []) {
      const at = text.search(r.keywordRe(p));
      if (at >= 0 && (!best || at < best.at)) best = { role, at, why: `"${p.replace(/\*$/, '')}"` };
    }
  }
  if (best) return { role: best.role, why: best.why };
  for (const role of roles) {
    const w = (role.starts || []).find((s) => startsRe(s).test(text));
    if (w && !(role.unless || []).some((u) => r.keywordRe(u).test(text))) return { role, why: `starts with "${w}"` };
  }
  return { role: defaultRole(roles), why: 'default' };
}

const roleNote = (role) => `${role.instructions}\n\nRequest: `;

// Roles mode: Claude or Codex for this role. A fuseway.frontier preference other than balance wins over the
// role's; a PDF or image goes to Claude, which reads them; a follow-up keeps its backend; a missing CLI or a
// provider out of room hands over to the other.
function pickBackend(role, { limits = {}, installed = { claude: true, codex: true }, frontier = 'balance', reserve, files = [], stay, now = Date.now() } = {}) {
  const pool = ['claude', 'codex'].filter((b) => installed[b]);
  if (frontier === 'grok') return { backend: 'grok', why: 'fuseway.frontier is grok' };
  if (!pool.length) throw new Error('no agent CLI found: install and sign in to Claude Code (`claude`) or Codex (`codex`), then try again. **Fuseway: Check Setup** shows what is missing.');
  if (files.some((f) => /\.(pdf|png|jpe?g|gif|webp|bmp)$/i.test(f.path)) && installed.claude) return { backend: 'claude', why: 'attachment needs a model that reads PDFs and images' };
  if (stay && pool.includes(stay)) return { backend: stay, why: `stays with ${r.LABELS[stay]}` };
  if (pool.length === 1) return { backend: pool[0], why: `only ${r.LABELS[pool[0]]} is installed` };
  const prefer = frontier !== 'balance' ? frontier : role.prefer || 'balance';
  return r.pickFrontier(limits, prefer, now, reserve);
}

// The run options a role sets. Settings still win where the user turned something off (allowEdits).
function roleOptions(role, backend, settings, { models = true } = {}) {
  const out = { allowEdits: settings.allowEdits && role.edits !== false };
  if (!models) return out;
  if (backend === 'claude' && role.claudeModel) out.claudeModel = role.claudeModel;
  if (backend === 'codex') {
    if (role.codexEffort) out.codexEffort = role.codexEffort;
    if (role.codexModel) out.codexModel = role.codexModel;
  }
  return out;
}

// auto: local-first once `fuseway model` has configured a local model, otherwise roles.
const routingMode = (setting = 'auto', localConfigured = false) => (setting === 'auto' ? (localConfigured ? 'local-first' : 'roles') : setting);

module.exports = { loadRoles, pickRole, roleNote, pickBackend, roleOptions, routingMode, defaultRole };
