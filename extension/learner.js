// The background learner: scores decision makers (routers) and agents from what actually happened, and slowly
// promotes a better router. No vscode imports, so node --test can run it.
//
// Everything is an event in one append-only log (~/.local/state/fuseway/learning.jsonl):
//   decision  { id, prompt, routers: { key: tier }, served: agent, local: bool }  one per routed request
//   router    { id, key, tier, tokens, ms }    a router's answer, added later (background shadow run)
//   outcome   { id, outcome, reason, explicit } success | fail for a decision's served agent
//   label     { id, label }                    what the right tier was: local | frontier
//   agent     { attempt, agent, outcome, explicit, in, out, ms, quota }  an agent attempt's result
//   escalated { id }                         the local answer failed and a frontier agent took over
//   bench     { key, prompt, want, tier, tokens, ms }  a router scored on a labeled case
//   switch    { from, to, reason }             the router in charge changed
// Scores are recomputed from the log, weighted by age, so recent results count most.
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE = path.join(os.homedir(), '.local', 'state', 'fuseway');
const LOG = process.env.FUSEWAY_LEARNING_LOG || path.join(STATE, 'learning.jsonl');
const DAY = 86_400_000;

const POLICY = {
  defaultRouter: 'cascade',
  halfLifeDays: 7, // a result's weight halves every week
  minEvidence: 15, // recent weighted results a router needs before it can take over; more earns nothing extra
  margin: 0.03, // a challenger must beat the router in charge by 3 points
  cooldownHours: 24, // at most one switch a day
  tokenPenaltyPer1K: 0.01, // each 1K paid tokens per decision costs one accuracy point
  latencyPenaltyPerSec: 0.005, // each second per decision costs half a point
  benchWeight: 0.5, // a labeled test case counts half as much as a real outcome
  keepDays: 90,
};

// Router candidates. A key names the candidate and the models it depends on, so a new local model is a new
// candidate with no history: it has to earn its place on recent results.
const ROUTERS = {
  cascade: { paid: true, describe: 'rules, local model matches the catalog, Haiku breaks ties' },
  'local-only': { paid: false, describe: 'rules and the local model, no Haiku (free)' },
  haiku: { paid: true, describe: 'rules, then Haiku alone' },
};
const routerKey = (name, localModel) => (name === 'haiku' ? 'haiku' : `${name}@${localModel || 'none'}`);
const routerName = (key) => key.split('@')[0];

// ---------- the log ----------

function append(event) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
  } catch {}
}

function load(now = Date.now()) {
  let text = '';
  try { text = fs.readFileSync(LOG, 'utf8'); } catch { return []; }
  const cutoff = now - POLICY.keepDays * DAY;
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.ts >= cutoff);
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---------- outcomes (pure) ----------

const FAILURE = /(didn'?t|doesn'?t|does not|did not) work|not working|still (fail|broken|wrong|not)|is wrong|\bwrong\b|\bbroke|got an? (error|exception)|traceback|stack trace|tests? (fail|still)|that's not|try again/i;

// What the next message in the same chat says about the previous answer: 'fail', 'success' or null (no signal).
function outcomeFromNextTurn(prevMeta, nextPrompt, nextCommand) {
  if (!prevMeta?.decisionId && !prevMeta?.attempt) return null;
  if (['local', 'claude', 'codex'].includes(nextCommand) && nextCommand !== prevMeta.backend) return 'fail'; // asked someone else
  if (FAILURE.test(nextPrompt || '')) return 'fail';
  return 'success'; // moved on without complaint
}

// The right tier, when an outcome shows it. Only local answers show it: a local success means local was enough,
// a local failure means frontier was needed. A frontier success says nothing about whether local would have done.
function labelFor(decision, outcome) {
  if (decision.escalated) return 'frontier';
  if (!decision.local) return null;
  return outcome === 'success' ? 'local' : outcome === 'fail' ? 'frontier' : null;
}

// ---------- scoring (pure) ----------

const weight = (ts, now) => 0.5 ** ((now - ts) / (POLICY.halfLifeDays * DAY));

// Fold the log into the latest decision state: final outcome (explicit feedback wins), label, router answers.
function decisions(events) {
  const byId = new Map();
  for (const e of events) {
    if (e.type === 'decision') byId.set(e.id, { ...e, routers: { ...(e.routers || {}) }, cost: { ...(e.cost || {}) } });
    const d = byId.get(e.id);
    if (!d) continue;
    if (e.type === 'router') { d.routers[e.key] = e.tier; d.cost[e.key] = { tokens: e.tokens || 0, ms: e.ms || 0 }; }
    if (e.type === 'outcome' && (e.explicit || !d.explicit)) { d.outcome = e.outcome; d.explicit = !!e.explicit; d.resolvedTs = e.ts; }
    if (e.type === 'label') d.label = e.label;
    if (e.type === 'escalated') d.escalated = true;
  }
  for (const d of byId.values()) if (!d.label) d.label = labelFor(d, d.outcome);
  return [...byId.values()];
}

// Per router key: recency-weighted accuracy on labeled decisions and test cases, paid tokens and latency.
function routerScores(events, now = Date.now()) {
  const s = {};
  const row = (key) => (s[key] ||= { key, w: 0, right: 0, costW: 0, tokens: 0, ms: 0, n: 0 });
  for (const d of decisions(events)) {
    for (const [key, tier] of Object.entries(d.routers)) {
      const c = d.cost?.[key];
      if (c) { const r = row(key); const w = weight(d.ts, now); r.costW += w; r.tokens += w * c.tokens; r.ms += w * c.ms; }
      if (!d.label || tier === 'same') continue;
      const r = row(key), w = weight(d.resolvedTs || d.ts, now);
      r.w += w; r.right += w * (tier === d.label ? 1 : 0); r.n++;
    }
  }
  for (const e of events) {
    if (e.type !== 'bench') continue;
    const r = row(e.key), w = weight(e.ts, now) * POLICY.benchWeight;
    r.w += w; r.right += w * (e.tier === e.want ? 1 : 0); r.n++;
    r.costW += w; r.tokens += w * (e.tokens || 0); r.ms += w * (e.ms || 0);
  }
  for (const r of Object.values(s)) {
    r.accuracy = r.w ? r.right / r.w : null;
    r.tokensPerDecision = r.costW ? r.tokens / r.costW : 0;
    r.secondsPerDecision = r.costW ? r.ms / r.costW / 1000 : 0;
    r.evidence = r.w;
    r.score = r.accuracy === null ? null
      : r.accuracy - POLICY.tokenPenaltyPer1K * (r.tokensPerDecision / 1000) - POLICY.latencyPenaltyPerSec * r.secondsPerDecision;
  }
  return s;
}

// Per agent (backend:model:effort): recency-weighted success rate, tokens, time and share of the 5-hour window.
function agentScores(events, now = Date.now()) {
  // One result per attempt: explicit feedback replaces the implicit "moved on" outcome instead of adding to it.
  const attempts = new Map();
  for (const e of events) {
    if (e.type !== 'agent' || !e.outcome) continue;
    const k = e.attempt || `${e.ts}-${Math.random()}`;
    if (!attempts.has(k) || e.explicit || !attempts.get(k).explicit) attempts.set(k, e);
  }
  const s = {};
  for (const e of attempts.values()) {
    const r = (s[e.agent] ||= { agent: e.agent, w: 0, ok: 0, tokens: 0, ms: 0, quota: 0, n: 0 });
    const w = weight(e.ts, now);
    r.w += w; r.ok += w * (e.outcome === 'success' ? 1 : 0); r.n++;
    r.tokens += w * ((e.in || 0) + (e.out || 0)); r.ms += w * (e.ms || 0); r.quota += w * (e.quota || 0);
  }
  for (const r of Object.values(s)) {
    r.success = r.w ? r.ok / r.w : null;
    r.tokensPerCall = r.w ? r.tokens / r.w : 0;
    r.secondsPerCall = r.w ? r.ms / r.w / 1000 : 0;
    r.quotaPerCall = r.w ? r.quota / r.w : 0;
  }
  return s;
}

function currentRouter(events, localModel) {
  const last = [...events].reverse().find((e) => e.type === 'switch');
  return last ? { key: last.to, since: last.ts } : { key: routerKey(POLICY.defaultRouter, localModel), since: 0 };
}

// The switching rule. Returns { key, switched, reason }.
function choose(scores, current, now = Date.now(), available = () => true) {
  const champ = scores[current.key];
  const eligible = Object.values(scores).filter((r) => r.score !== null && r.evidence >= POLICY.minEvidence && available(r.key));
  if (!available(current.key) && eligible.length) {
    const best = eligible.reduce((a, b) => (b.score > a.score ? b : a));
    return { key: best.key, switched: true, reason: `${current.key} is no longer available` };
  }
  if (now - current.since < POLICY.cooldownHours * 3_600_000) return { key: current.key, switched: false, reason: 'cooling down' };
  const best = eligible.filter((r) => r.key !== current.key).reduce((a, b) => (!a || b.score > a.score ? b : a), null);
  if (!best) return { key: current.key, switched: false, reason: 'no challenger with enough recent evidence' };
  const champScore = champ?.evidence >= POLICY.minEvidence ? champ.score : null;
  if (champScore === null || best.score >= champScore + POLICY.margin) {
    const pts = (x) => (x * 100).toFixed(1);
    return { key: best.key, switched: true,
      reason: champScore === null ? `${current.key} has too little recent evidence; ${best.key} scores ${pts(best.score)}`
        : `${best.key} scores ${pts(best.score)} vs ${pts(champScore)} for ${current.key}` };
  }
  return { key: current.key, switched: false, reason: 'no challenger is far enough ahead' };
}

// Paid tokens the learner itself spent in the last day (shadow runs and test cases), to stay under a budget.
function paidToday(events, now = Date.now()) {
  return events.filter((e) => (e.type === 'router' || e.type === 'bench') && e.background && now - e.ts < DAY)
    .reduce((sum, e) => sum + (e.tokens || 0), 0);
}

// ---------- reports ----------

function statsMarkdown(events, localModel, now = Date.now()) {
  const cur = currentRouter(events, localModel);
  const all = routerScores(events, now);
  for (const name of Object.keys(ROUTERS)) {
    const key = routerKey(name, localModel);
    all[key] ||= { key, score: null, accuracy: null, evidence: 0, tokensPerDecision: 0, secondsPerDecision: 0 };
  }
  const rs = Object.values(all).sort((a, b) => (b.score ?? -9) - (a.score ?? -9));
  const as = Object.values(agentScores(events, now)).sort((a, b) => (b.success ?? -1) - (a.success ?? -1));
  const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
  const lastSwitch = [...events].reverse().find((e) => e.type === 'switch');
  return [
    `**Decision maker:** \`${cur.key}\` (${ROUTERS[routerName(cur.key)]?.describe || 'custom'})${lastSwitch ? `, since ${new Date(lastSwitch.ts).toLocaleDateString()}: ${lastSwitch.reason}` : ', the default'}`,
    '', `Weighted by age (half-life ${POLICY.halfLifeDays} days). A challenger needs ${POLICY.minEvidence} recent results and a ${POLICY.margin * 100}-point lead to take over.`, '',
    '| Router | Score | Accuracy | Recent evidence | Paid tokens / decision | s / decision |', '|---|---|---|---|---|---|',
    ...rs.map((r) => `| ${r.key === cur.key ? '**' + r.key + '**' : r.key} | ${r.score === null ? '–' : (r.score * 100).toFixed(1)} | ${pct(r.accuracy)} | ${r.evidence.toFixed(1)} | ${Math.round(r.tokensPerDecision)} | ${r.secondsPerDecision.toFixed(1)} |`),
    '', '| Agent | Success | Calls | Tokens / call | s / call | 5h window / call |', '|---|---|---|---|---|---|',
    ...as.map((a) => `| ${a.agent} | ${pct(a.success)} | ${a.n} | ${Math.round(a.tokensPerCall)} | ${a.secondsPerCall.toFixed(1)} | ${a.quotaPerCall ? (a.quotaPerCall * 100).toFixed(1) + '%' : '–'} |`),
  ].join('\n');
}

// Labeled prompts for scoring a thin candidate: this machine's own resolved decisions first (so it improves with
// use), then the shipped cases.
function benchCases(events) {
  const builtIn = (() => { try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'route-cases.json'), 'utf8')); return [...c.fresh, ...c.heldOut, ...c.seen]; } catch { return []; } })();
  const real = decisions(events).filter((d) => d.label && d.prompt).reverse().map((d) => [d.prompt, d.label]);
  const seen = new Set();
  return [...real, ...builtIn].filter(([p]) => !seen.has(p) && seen.add(p));
}

// One quiet background pass. 1: fill in missing router answers on the last two days of decisions. 2: give
// candidates without enough recent evidence labeled cases. Free routers always run; paid ones only within the
// daily budget. Stops when a request comes in, when the local model is down, or after maxJobs.
async function tick({ classifyWith, offline, localModel, budget, ctx = (prompt) => ({ prompt }), isBusy = () => false, now = Date.now(), maxJobs = 6 }) {
  const events = load(now);
  let spent = paidToday(events, now), jobs = 0;
  const go = async (name) => {
    if (jobs >= maxJobs || isBusy()) return false;
    if (ROUTERS[name].paid && spent >= budget) return null;
    return true;
  };
  const run = async (name, prompt) => {
    const out = await classifyWith(name, ctx(prompt));
    jobs++;
    if (offline(out)) throw new Error('local model offline');
    spent += out.paidTokens || 0;
    return out;
  };
  try {
    for (const d of decisions(events).filter((x) => now - x.ts < 2 * DAY && x.prompt).reverse()) {
      for (const name of Object.keys(ROUTERS)) {
        const key = routerKey(name, localModel);
        if (d.routers[key] !== undefined) continue;
        const ok = await go(name);
        if (ok === false) return;
        if (!ok) continue;
        const out = await run(name, d.prompt);
        append({ type: 'router', id: d.id, key, tier: out.tier, tokens: out.paidTokens, ms: out.ms, background: true });
      }
    }
    const scores = routerScores(events, now);
    const cases = benchCases(events);
    for (const name of Object.keys(ROUTERS)) {
      const key = routerKey(name, localModel);
      if ((scores[key]?.evidence || 0) >= POLICY.minEvidence) continue;
      const done = new Set(events.filter((e) => e.type === 'bench' && e.key === key && now - e.ts < POLICY.halfLifeDays * DAY).map((e) => e.prompt));
      for (const [prompt, want] of cases.filter(([p]) => !done.has(p))) {
        const ok = await go(name);
        if (ok === false) return;
        if (!ok) break;
        const out = await run(name, prompt);
        append({ type: 'bench', key, prompt, want, tier: out.tier, tokens: out.paidTokens, ms: out.ms, background: true });
      }
    }
  } catch (e) {
    if (e.message !== 'local model offline') throw e;
  }
}

function reconsider(localModel, now = Date.now()) {
  const events = load(now);
  const cur = currentRouter(events, localModel);
  // Routers built on a local model that's no longer configured can't run.
  const available = (key) => !key.includes('@') || key.endsWith(`@${localModel || 'none'}`);
  const pick = choose(routerScores(events, now), cur, now, available);
  if (pick.switched) append({ type: 'switch', from: cur.key, to: pick.key, reason: pick.reason });
  return pick;
}

module.exports = { tick, reconsider, benchCases, POLICY, ROUTERS, LOG, routerKey, routerName, append, load, newId, outcomeFromNextTurn, labelFor, decisions,
  routerScores, agentScores, currentRouter, choose, paidToday, statsMarkdown, weight };
