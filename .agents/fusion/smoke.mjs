#!/usr/bin/env node
// Drives .agents/fusion/server.mjs over stdio like an MCP client and checks each tool's real reply.
//   node .agents/fusion/smoke.mjs                    all backends (spends a little quota)
//   node .agents/fusion/smoke.mjs ask_local          just the named tools
// Usage from the smoke test goes to a scratch log, not .agents/usage.jsonl.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const only = process.argv.slice(2);
const log = join(tmpdir(), `fusion-smoke-${process.pid}.jsonl`);
const server = spawn('node', [new URL('./server.mjs', import.meta.url).pathname], {
  stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, FUSION_LOG: log },
});
const pending = new Map();
createInterface({ input: server.stdout }).on('line', (l) => {
  const m = JSON.parse(l);
  pending.get(m.id)?.(m);
});
let next = 1;
const rpc = (method, params) => new Promise((resolve) => {
  const id = next++;
  pending.set(id, resolve);
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); failed += ok ? 0 : 1; };

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
check('initialize', init.result?.serverInfo?.name === 'fusion');
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const names = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
check('tools/list', ['ask_local', 'ask_claude', 'ask_codex', 'critique'].every((n) => names.includes(n)), names.join(', '));

const cases = {
  ask_local: { prompt: 'Reply with only the word pong. /no_think' },
  ask_claude: { prompt: 'Reply with only the word pong.', model: 'haiku' },
  ask_codex: { prompt: 'Reply with only the word pong.', effort: 'low' },
  critique: { subject: 'Plan: store user passwords in plain text in a public S3 bucket so login is fast.' },
};
for (const [name, args] of Object.entries(cases)) {
  if (only.length && !only.includes(name)) continue;
  const t = Date.now();
  const r = (await rpc('tools/call', { name, arguments: args })).result;
  const text = r.content[0].text;
  const ok = !r.isError && (name === 'critique'
    ? text.includes('## Claude review') && text.includes('## Codex review') && !text.includes('(failed:')
    : /pong/i.test(text));
  check(name, ok, `${((Date.now() - t) / 1000).toFixed(1)}s ${JSON.stringify(text.slice(0, name === 'critique' ? 400 : 120))}`);
}
server.kill();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
