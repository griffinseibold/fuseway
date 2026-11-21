import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const fail = message => { throw new Error(message); };
const integer = (x, max) => Number.isInteger(x) && x > 0 && x <= max;
export function validateConfig(c) {
  if (!c || typeof c !== 'object') fail('company config must be a JSON object');
  if (c.version !== 1) fail('company.json must use version: 1; review and update the owner configuration');
  if (!Array.isArray(c.roster) || !c.roster.length || c.roster.length > 16) fail('company roster needs 1..16 profiles');
  const ids = new Set();
  for (const p of c.roster) {
    if (!p || typeof p.id !== 'string' || !idPattern.test(p.id) || ids.has(p.id)) fail('roster IDs must be unique safe names');
    ids.add(p.id);
    if (!['local', 'claude', 'codex', 'grok'].includes(p.backend) || typeof p.enabled !== 'boolean') fail(`Invalid backend/enabled for ${p.id}`);
    if (!Array.isArray(p.roles) || !p.roles.length || p.roles.some(r => !['ceo','builder','researcher','reviewer'].includes(r))) fail(`Invalid roles for ${p.id}`);
    if (p.model !== undefined && (typeof p.model !== 'string' || !p.model.trim() || p.model.length > 200)) fail(`Invalid model for ${p.id}`);
    if (p.effort !== undefined && (!['local','codex'].includes(p.backend) || !['low','medium','high'].includes(p.effort))) fail(`Effort for ${p.id} is supported only on local/Codex profiles, using low, medium or high`);
  }
  if (!c.roster.some(p => p.id === c.leader && p.enabled && p.roles.includes('ceo'))) fail('leader must name an enabled CEO');
  if (!c.roster.some(p => p.enabled && p.roles.some(r => r !== 'ceo'))) fail('Enable at least one worker');
  const b = c.budget;
  if (!b || !integer(b.calls, 32) || b.calls < 2 || !integer(b.teamMs, 3600000) || !integer(b.challengeMs, 14400000) || !integer(b.checkMs, 300000)) fail('budget needs calls 2..32, teamMs <=3600000, challengeMs <=14400000, checkMs <=300000');
  if (b.observedTokens !== undefined && !integer(b.observedTokens, 1000000000)) fail('observedTokens must be a positive integer');
  return c;
}
export function validateMission(m) {
  if (!m || typeof m.id !== 'string' || !idPattern.test(m.id) || typeof m.goal !== 'string' || !m.goal.trim() || m.goal.length > 20000) fail('mission needs a safe id and nonempty goal <=20000 characters');
  if (!Array.isArray(m.checks) || !m.checks.length || m.checks.length > 16 || m.checks.some(c => !Array.isArray(c) || !c.length || c.length > 128 || c.some(a => typeof a !== 'string' || a.includes('\0')) || !c[0])) fail('mission checks must be nonempty argv arrays');
  if (!Array.isArray(m.protectedPaths) || !m.protectedPaths.length || m.protectedPaths.some(p => typeof p !== 'string' || !p || isAbsolute(p) || p.split(/[\\/]/).some(x => ['..','.git'].includes(x) || p === '.fuseway/company' || p.startsWith('.fuseway/company/')))) fail('protectedPaths must name repository verifier files outside .git and .fuseway/company runtime data');
  return m;
}
export function init(root) {
  mkdirSync(join(root, '.fuseway'), { recursive: true });
  const files = {
    'company.json': JSON.stringify({ version: 1, leader: 'local-ceo', roster: [
      { id:'local-ceo', backend:'local', enabled:true, roles:['ceo'] },
      { id:'local-builder', backend:'local', enabled:true, roles:['builder'] },
      { id:'local-reviewer', backend:'local', enabled:true, roles:['reviewer'] },
      { id:'claude-ceo', backend:'claude', model:'sonnet', enabled:false, roles:['ceo'] },
      { id:'codex-ceo', backend:'codex', effort:'medium', enabled:false, roles:['ceo'] },
      { id:'grok-ceo', backend:'grok', enabled:false, roles:['ceo'] }
    ], budget:{ calls:6, teamMs:300000, challengeMs:1200000, checkMs:30000 } }, null, 2)+'\n',
    'example-mission.json': JSON.stringify({ id:'greeting', goal:'Delegate to a builder to create greeting.txt containing exactly Hello Fuseway! followed by a newline. Then delegate to a reviewer to inspect the result.', checks:[['node','.fuseway/check-greeting.mjs']], protectedPaths:['.fuseway/check-greeting.mjs'] },null,2)+'\n',
    'check-greeting.mjs': "import { readFileSync } from 'node:fs';\nimport assert from 'node:assert/strict';\nassert.equal(readFileSync('greeting.txt', 'utf8'), 'Hello Fuseway!\\n');\n"
  };
  // Verifier files may live beside config, but runtime data must never be a verifier.
  for (const [name, value] of Object.entries(files)) if (!existsSync(join(root,'.fuseway',name))) writeFileSync(join(root,'.fuseway',name), value, { flag:'wx' });
  const ignore = join(root,'.gitignore');
  const before = existsSync(ignore) ? readFileSync(ignore,'utf8') : '';
  if (!before.split('\n').includes('/.fuseway/company/')) appendFileSync(ignore, `${before && !before.endsWith('\n') ? '\n' : ''}/.fuseway/company/\n`);
  return 'Created owner config and example in .fuseway/. Review roster and budgets, then commit config, mission and verifier before running.';
}
export function validatePlan(text, config) {
  if (typeof text !== 'string' || text.length > 32000) fail('CEO plan exceeds 32000 characters');
  let plan;
  try { plan = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,'')); } catch { fail('CEO must return a JSON task graph'); }
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > config.budget.calls - 1) fail('CEO must delegate 1..calls-1 tasks');
  const seen = new Set();
  for (const t of plan.tasks) {
    if (!t || typeof t !== 'object') fail('Each CEO task must be a JSON object');
    const p = config.roster.find(p => p.id === t.worker && p.enabled && p.roles.some(r => r !== 'ceo'));
    if (typeof t.id !== 'string' || !idPattern.test(t.id) || seen.has(t.id) || !p || typeof t.prompt !== 'string' || !t.prompt.trim() || t.prompt.length > 12000 || !Array.isArray(t.dependsOn) || t.dependsOn.some(d => !seen.has(d))) fail('Invalid task, worker, dependency or cycle; tasks must be in dependency order');
    seen.add(t.id);
  }
  return { tasks:plan.tasks.map(({id,worker,prompt,dependsOn}) => ({id,worker,prompt,dependsOn})) };
}
