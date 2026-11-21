#!/usr/bin/env node
// Scores the real router (Qwen, then Haiku on FRONTIER) on labeled requests. Spends ~1K Claude tokens per Haiku call.
//   node extension/route-eval.mjs
// Labels are judgment calls; add cases when the router gets one wrong in real use.
import { createRequire } from 'node:module';
const r = createRequire(import.meta.url)('./router.js');

const CASES = [
  ['Write a docstring for: def add(a, b): return a + b', 'local'],
  ['Convert this JSON to YAML: {"name": "api", "replicas": 3}', 'local'],
  ['Generate a .gitignore for a Node + Vite project', 'local'],
  ["Summarize this log: 'ERROR db timeout after 30s' repeated 400 times between 02:00 and 02:05", 'local'],
  ['Rename the variable tmp to retryCount in this 20-line function', 'local'],
  ['Write a unit test for a function that reverses a string', 'local'],
  ['Add a .agents/context entry describing how the backup script works (I pasted the script)', 'local'],
  ['Draft a commit message for this diff that bumps a dependency version', 'local'],
  ['Design auth for a multi-tenant SaaS with SSO and per-tenant roles', 'frontier'],
  ['Our pods OOM only under load, but memory limits look fine. Here are the manifests. Why?', 'frontier'],
  ['Plan migrating 12 services from REST to gRPC without downtime', 'frontier'],
  ['Find the race condition in this concurrent cache code', 'frontier'],
  ['Refactor this 2,000-line module into a plugin system', 'frontier'],
  ['Tests pass locally but fail intermittently in CI. How do we find out why?', 'frontier'],
  ['Review this diff that changes how we hash and store passwords', 'frontier'],
  ['Add pagination to the list endpoint and update the three callers in other packages', 'frontier'],
];

let right = 0, haiku = 0, tokens = 0;
const start = Date.now();
for (const [prompt, want] of CASES) {
  const out = await r.classify(prompt, null, { qwen: r.askQwen, haiku: async (i) => { haiku++; const h = await r.askHaiku(i); tokens += h.tokens; return h; }, log: () => {} });
  if (out.tier === want) right++;
  else console.log(`  miss  want ${want}, got ${out.tier} (${out.trail.join(' → ')}): ${prompt.slice(0, 60)}`);
}
console.log(`${right}/${CASES.length} correct; Haiku consulted ${haiku}/${CASES.length} times (${tokens} Claude tokens total); ${((Date.now() - start) / CASES.length / 1000).toFixed(2)} s per decision`);
