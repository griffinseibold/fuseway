#!/usr/bin/env node
// Scores the real router (rules, the local model's rule matching, Haiku) on labeled requests.
// Spends ~1K Claude tokens per Haiku call.
//   node extension/route-eval.mjs [--verbose]
// Labels are judgment calls; add cases when the router gets one wrong in real use.
import { createRequire } from 'node:module';
const r = createRequire(import.meta.url)('./router.js');
const verbose = process.argv.includes('--verbose');

// Written alongside the keyword lists, so many of these hit a keyword.
const SEEN = [
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
// Phrased to avoid the catalog's keywords. Several still paraphrase the catalog's own examples, so they overstate accuracy.
const HELD_OUT = [
  ["Can someone see another customer's orders if they change the number at the end of the URL?", 'frontier'],
  ['Make it so people can sign in with their Google account', 'frontier'],
  ['Our nightly job sometimes handles the same order twice', 'frontier'],
  ['Why does the app get slower the longer it runs?', 'frontier'],
  ["Users in Sydney see yesterday's date on their dashboard", 'frontier'],
  ['The cart total is sometimes a cent higher than it should be', 'frontier'],
  ['Pick between Postgres and Mongo for storing chat history', 'frontier'],
  ['Move user uploads from the local disk to S3 without losing any files', 'frontier'],
  ['Add a phone number field to the users table', 'frontier'],
  ['Ship to the servers automatically whenever we tag a release', 'frontier'],
  ['The export works on my laptop but not for anyone else', 'frontier'],
  ['Anything risky in this change before I merge it?', 'frontier'],
  ['Make the admin page reachable from outside our office network', 'frontier'],
  ['A customer asked us to erase everything we store about them', 'frontier'],
  ['Two people booking at the same moment can both get the last seat', 'frontier'],
  ['Clean out all order records older than 2019', 'frontier'],
  ['How should we structure notifications across email, push and text?', 'frontier'],
  ['Can we bundle this AGPL library into our paid desktop app?', 'frontier'],
  ["Make this error message sound friendlier: 'Err 5: bad thing happened'", 'local'],
  ['Turn these names into a TypeScript union type: alice, bob, carol', 'local'],
  ['Make up 20 example users with names and emails I can paste into a test', 'local'],
  ["Walk me through this command: find . -name '*.log' -mtime +7", 'local'],
  ['Turn these meeting notes into a list of action items: ship v2 friday, Sam owns docs, revisit pricing', 'local'],
  ["Write a function that turns 1536 into '1.5 KB'", 'local'],
  ['Make the save button blue and center it under the form', 'local'],
  ['These button labels in Spanish please: Save, Cancel, Back', 'local'],
  ["Replace the repeated 'pending' and 'shipped' strings in this file with named values", 'local'],
  ['Show me how to call parseConfig() with a custom path', 'local'],
  ['Flatten these nested if statements', 'local'],
  ['Sort these names alphabetically and drop the repeats: Bob, alice, Carol, bob', 'local'],
  ['Describe the images on the about page for screen readers', 'local'],
];

// Written after the catalog, resembling none of its examples: the fairest of the three sets.
const FRESH = [
  ["Store the user's session in a cookie instead of localStorage", 'frontier'],
  ['Our webhook receiver accepts requests from anyone; lock it down', 'frontier'],
  ['The leaderboard shows wrong ranks when two scores tie and update at once', 'frontier'],
  ['Speed up the search endpoint, it scans the whole products table', 'frontier'],
  ['Split the user service out into its own deployable', 'frontier'],
  ['Figure out why memory on the worker climbs until it restarts every night', 'frontier'],
  ['Add an undo for bulk-deleting tasks', 'frontier'],
  ['Swap the database user the reporting job connects as for a new one', 'frontier'],
  ['Should the mobile app talk to the database directly or go through our API?', 'frontier'],
  ['Retry failed emails without sending anyone a duplicate', 'frontier'],
  ['Add a loading spinner to the submit button', 'local'],
  ['Write a Python function that checks if a string is a palindrome', 'local'],
  ['Turn this paragraph into three bullet points: we shipped the beta, feedback was mixed, next we fix onboarding', 'local'],
  ['Give the variables in this snippet clearer names', 'local'],
  ["What is this SQL doing: SELECT name FROM users WHERE created_at > now() - interval '7 days'", 'local'],
  ["Make a package.json script called 'dev' that runs vite", 'local'],
  ['Pad these numbers with leading zeros to 5 digits: 12, 345, 7', 'local'],
  ['Write a short, friendly welcome message for the CLI', 'local'],
  ['Change the copyright year in the footer to 2026', 'local'],
  ["Add a --verbose flag that prints each file as it's processed", 'local'],
];

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
