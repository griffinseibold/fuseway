#!/usr/bin/env node
// Whole-task eval: does local-first routing save frontier tokens without losing task success?
//   node eval/run-tasks.mjs --check-tests                     prove every test fails on the start files and passes on the reference solution
//   node eval/run-tasks.mjs --arm frontier [--frontier codex] all tasks straight to one frontier agent (the baseline)
//   node eval/run-tasks.mjs --arm local-first [--frontier codex]  route like @fuseway; escalate to the same frontier agent when tests fail
//   node eval/run-tasks.mjs --report                          compare the arms from the saved results
// Options: --only id,id  --out file (default eval/results.jsonl)  --repeat N
// Success is only ever "the tests pass", run by the harness after restoring the original test file.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASKS } from './tasks.mjs';

const r = createRequire(import.meta.url)('../extension/router.js');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true; };
const OUT = flag('out', new URL('./results.jsonl', import.meta.url).pathname);
const only = flag('only') ? String(flag('only')).split(',') : null;
const tasks = TASKS.filter((t) => !only || only.includes(t.id));
const SUFFIX = '\n\nThe tests are in test.mjs; run them with `node --test test.mjs`. Make them pass. Do not edit test.mjs.';

function workspace(task, files) {
  const dir = mkdtempSync(join(tmpdir(), `fuseway-task-${task.id}-`));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  writeFileSync(join(dir, 'test.mjs'), task.test);
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  return dir;
}

function check(task, dir) {
  writeFileSync(join(dir, 'test.mjs'), task.test); // undo any edits to the tests
  const t = spawnSync(process.execPath, ['--test', 'test.mjs'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  return { pass: t.status === 0, output: `${t.stdout}${t.stderr}`.split('\n').filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 12).join('\n') };
}

if (flag('check-tests')) {
  let bad = 0;
  for (const t of tasks) {
    const start = check(t, workspace(t, t.files)).pass, solved = check(t, workspace(t, t.solution)).pass;
    const ok = !start && solved;
    bad += ok ? 0 : 1;
    console.log(`${ok ? 'ok  ' : 'BAD '} ${t.id.padEnd(16)} start files: ${start ? 'PASS (too easy)' : 'fail'}, reference solution: ${solved ? 'pass' : 'FAIL (broken test)'}`);
  }
  process.exit(bad ? 1 : 0);
}

async function attempt(backend, task, dir, prompt, frontierEffort) {
  const t0 = Date.now();
  try {
    const res = await r.run(backend, { prompt, cwd: dir, allowEdits: true, claudeModel: 'sonnet', codexEffort: frontierEffort });
    const c = check(task, dir);
    return { backend, model: res.model, in: res.inTok, out: res.outTok, quota: res.quota || 0, ms: Date.now() - t0, pass: c.pass, output: c.output };
  } catch (e) {
    const c = check(task, dir);
    return { backend, error: e.message.slice(0, 200), in: 0, out: 0, quota: 0, ms: Date.now() - t0, pass: c.pass, output: c.output };
  }
}

async function runArm(arm) {
  const frontier = flag('frontier', 'codex');
  const effort = flag('effort', 'medium');
  const repeat = Number(flag('repeat', 1));
  const rules = r.loadRules();
  const localContext = r.localConfig()?.contextWindow;
  for (let rep = 0; rep < repeat; rep++) {
    for (const task of tasks) {
      const dir = workspace(task, task.files);
      const prompt = task.prompt + SUFFIX;
      const attempts = [];
      let route = null;
      if (arm === 'frontier') attempts.push(await attempt(frontier, task, dir, prompt, effort));
      else {
        route = await r.classifyWith('cascade', { prompt, rules, localContext });
        if (route.tier === 'local') {
          attempts.push(await attempt('local', task, dir, prompt, effort));
          if (!attempts[0].pass) {
            // Same escalation as @fuseway: the frontier agent gets the failing output and the same workspace.
            const handoff = `${prompt}\n\nA previous attempt left the tests failing:\n${attempts[0].output || attempts[0].error || '(no output)'}`;
            attempts.push(await attempt(frontier, task, dir, handoff, effort));
          }
        } else attempts.push(await attempt(frontier, task, dir, prompt, effort));
      }
      const last = attempts.at(-1);
      const sum = (pred, f) => attempts.filter(pred).reduce((s, a) => s + f(a), 0);
      const row = { ts: new Date().toISOString(), arm, task: task.id, frontier: `${frontier}:${effort}`, route: route ? { tier: route.tier, trail: route.trail } : null,
        pass: last.pass, escalated: attempts.length > 1, attempts,
        frontierTokens: sum((a) => a.backend !== 'local', (a) => a.in + a.out), localTokens: sum((a) => a.backend === 'local', (a) => a.in + a.out),
        frontierQuota: sum((a) => a.backend !== 'local', (a) => a.quota), routerPaidTokens: route?.paidTokens || 0, ms: sum(() => true, (a) => a.ms) };
      appendFileSync(OUT, JSON.stringify(row) + '\n');
      console.log(`${arm.padEnd(11)} ${task.id.padEnd(16)} ${last.pass ? 'PASS' : 'FAIL'}  ${attempts.map((a) => `${a.backend}${a.pass ? '✓' : '✗'}`).join(' → ').padEnd(22)} frontier ${String(row.frontierTokens).padStart(7)} tok  local ${String(row.localTokens).padStart(6)} tok  ${(row.ms / 1000).toFixed(0)} s`);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function report() {
  if (!existsSync(OUT)) return console.log(`No results yet (${OUT}).`);
  const rows = readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => !only || only.includes(x.task));
  const arms = {};
  for (const x of rows) {
    const a = (arms[`${x.arm} (${x.frontier})`] ||= { n: 0, pass: 0, escalated: 0, routedLocal: 0, localSolved: 0, frontierTokens: 0, localTokens: 0, routerPaid: 0, quota: 0, ms: 0, fails: {} });
    a.n++; a.pass += x.pass ? 1 : 0; a.escalated += x.escalated ? 1 : 0;
    a.routedLocal += x.route?.tier === 'local' ? 1 : 0; a.localSolved += x.attempts[0]?.backend === 'local' && x.attempts[0].pass ? 1 : 0;
    a.frontierTokens += x.frontierTokens; a.localTokens += x.localTokens; a.routerPaid += x.routerPaidTokens; a.quota += x.frontierQuota; a.ms += x.ms;
    for (const t of x.attempts) if (!t.pass) a.fails[t.backend] = (a.fails[t.backend] || 0) + 1;
  }
  console.log('| Arm | N | Tests pass | Routed local | Solved locally | Escalated | Frontier tokens | Router tokens (Haiku) | Local tokens | Failed attempts by backend | Time |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [name, a] of Object.entries(arms)) {
    console.log(`| ${name} | ${a.n} | ${a.pass}/${a.n} | ${a.routedLocal} | ${a.localSolved} | ${a.escalated} | ${a.frontierTokens.toLocaleString()} | ${a.routerPaid.toLocaleString()} | ${a.localTokens.toLocaleString()} | ${Object.entries(a.fails).map(([b, n]) => `${b} ${n}`).join(', ') || 'none'} | ${(a.ms / 60000).toFixed(1)} min |`);
  }
  const lf = Object.entries(arms).find(([k]) => k.startsWith('local-first')), fr = Object.entries(arms).find(([k]) => k.startsWith('frontier'));
  if (lf && fr) {
    const [, l] = lf, [, f] = fr;
    const saved = 1 - (l.frontierTokens + l.routerPaid) / f.frontierTokens;
    console.log(`\nLocal-first used ${(saved * 100).toFixed(0)}% fewer frontier tokens (including Haiku routing) than all-frontier: ${(l.frontierTokens + l.routerPaid).toLocaleString()} vs ${f.frontierTokens.toLocaleString()}, with ${l.pass}/${l.n} vs ${f.pass}/${f.n} tasks passing.`);
  }
}

if (flag('report')) report();
else if (flag('arm') === 'frontier' || flag('arm') === 'local-first') { await runArm(flag('arm')); report(); }
else { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n')); process.exit(2); }
