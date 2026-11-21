#!/usr/bin/env node
// Scores the real router (rules, the local model's rule matching, Haiku) on labeled requests.
// Spends ~1K Claude tokens per Haiku call.
//   node extension/route-eval.mjs [--verbose]
// Labels are judgment calls; add cases when the router gets one wrong in real use.
import { createRequire } from 'node:module';
const r = createRequire(import.meta.url)('./router.js');
const verbose = process.argv.includes('--verbose');

import { readFileSync } from 'node:fs';
const { seen: SEEN, heldOut: HELD_OUT, fresh: FRESH } = JSON.parse(readFileSync(new URL('./route-cases.json', import.meta.url), 'utf8'));

const rules = r.loadRules();
const localContext = r.localConfig()?.contextWindow;
const paths = {};
let haiku = 0, tokens = 0;
const t0 = Date.now();
async function score(name, cases) {
  let right = 0;
  for (const [prompt, want] of cases) {
    const out = await r.classify({ prompt, localContext, rules }, {
      qwen: r.askQwen, log: () => {},
      haiku: async (i, hint) => { haiku++; const h = await r.askHaiku(i, hint); tokens += h.tokens; return h; },
    });
    const how = out.trail.some((t) => t.startsWith('Haiku')) ? 'Haiku decided' : out.trail.some((t) => t.startsWith('rule ≈')) ? 'matched by meaning'
      : out.trail[0].startsWith('rule:') ? 'keyword or structural rule' : 'Qwen tier, no rule';
    paths[how] = (paths[how] || 0) + 1;
    if (out.tier === want) right++;
    if (out.tier !== want || verbose) console.log(`  ${out.tier === want ? 'ok  ' : 'MISS'}  want ${want}, got ${out.tier} (${out.trail.join(' → ')}): ${prompt.slice(0, 70)}`);
  }
  console.log(`${name}: ${right}/${cases.length} correct`);
}
await score('seen', SEEN);
await score('held out (no keywords)', HELD_OUT);
await score('fresh (fairest)', FRESH);
const n = SEEN.length + HELD_OUT.length + FRESH.length;
console.log(`decided by: ${Object.entries(paths).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`Haiku consulted ${haiku}/${n} times (${tokens} Claude tokens); ${((Date.now() - t0) / n / 1000).toFixed(2)} s per decision`);
