#!/usr/bin/env node
// fusion: an MCP server (stdio) that lets one chat hand work to other models
// through their official CLIs, so each call spends that tool's subscription quota.
//   node fusion/server.mjs          serve MCP on stdin/stdout
//   node fusion/server.mjs report   summarize the usage log
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = process.env.FUSION_WORKSPACE || REPO;
const LOG = process.env.FUSION_LOG || join(REPO, '.agents', 'usage.jsonl');
const TIMEOUT_MS = Number(process.env.FUSION_TIMEOUT_MS || 600_000);
const LOCAL_URL = (process.env.LOCAL_LLM_URL || 'http://llm.localhost:8080/v1').replace(/\/$/, '');
const CHILD_ENV = { ...process.env, FUSION_CHILD: '1' };

function which(name, fallbacks = []) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return fallbacks.find(existsSync) || name;
}
const CLAUDE_BIN = process.env.CLAUDE_BIN || which('claude');
// The ChatGPT desktop app bundles a Codex CLI even when none is on PATH.
const CODEX_BIN = process.env.CODEX_BIN || which('codex', ['/usr/lib/chatgpt/resources/codex']);

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: WORKSPACE, env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`${bin}: ${e.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`${bin} killed by ${signal} (timeout ${TIMEOUT_MS} ms?)`));
      resolve({ code, out, err });
    });
  });
}

// Each backend turns tool arguments into { text, model, inTok, outTok, costUsd? }.
const BACKENDS = {
  async claude({ prompt, model = 'sonnet', write = false }) {
    const args = ['-p', prompt, '--output-format', 'json', '--model', model,
      '--permission-mode', write ? 'acceptEdits' : 'plan',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence'];
    const { code, out, err } = await run(CLAUDE_BIN, args);
    let r;
    try { r = JSON.parse(out); } catch { throw new Error(`claude exited ${code}: ${(err || out).slice(-2000)}`); }
    if (r.is_error) throw new Error(`claude: ${r.result || r.subtype}`);
    const u = r.usage || {};
    return {
      text: r.result, model,
      inTok: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      outTok: u.output_tokens || 0,
      costUsd: r.total_cost_usd, // API list price; on a subscription this is quota, not money
    };
  },

  async codex({ prompt, effort = 'medium', write = false }) {
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check',
      '--sandbox', write ? 'workspace-write' : 'read-only',
      '-c', `model_reasoning_effort="${effort}"`, prompt];
    const { code, out, err } = await run(CODEX_BIN, args);
    let text = '', inTok = 0, outTok = 0;
    for (const line of out.split('\n')) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text;
      if (ev.type === 'turn.completed') { inTok += ev.usage?.input_tokens || 0; outTok += ev.usage?.output_tokens || 0; }
      if (ev.type === 'error' || ev.type === 'turn.failed') throw new Error(`codex: ${ev.message || ev.error?.message || line}`);
    }
    if (code !== 0 || !text) throw new Error(`codex exited ${code}: ${err.slice(-2000) || 'no reply'}`);
    return { text, model: `effort=${effort}`, inTok, outTok };
  },

  async local({ prompt, system }) {
    const messages = system ? [{ role: 'system', content: system }] : [];
    messages.push({ role: 'user', content: prompt });
    const ctl = AbortSignal.timeout(TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${LOCAL_URL}/chat/completions`, {
        method: 'POST', signal: ctl, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.LOCAL_LLM_MODEL || 'local', messages, stream: false }),
      });
    } catch (e) {
      throw new Error(`local model unreachable at ${LOCAL_URL} (${e.cause?.code || e.message}). Is llama-server running?`);
    }
    if (!res.ok) throw new Error(`local model HTTP ${res.status}: ${(await res.text()).slice(0, 1000)}`);
    const r = await res.json();
    return {
      text: r.choices?.[0]?.message?.content ?? '', model: r.model || 'local',
      inTok: r.usage?.prompt_tokens || 0, outTok: r.usage?.completion_tokens || 0,
    };
  },
};

async function call(backend, args) {
  const start = Date.now();
  const entry = { ts: new Date().toISOString(), backend, write: !!args.write };
  try {
    const r = await BACKENDS[backend](args);
    Object.assign(entry, { ok: true, model: r.model, in: r.inTok, out: r.outTok, cost_usd: r.costUsd });
    return r.text;
  } catch (e) {
    Object.assign(entry, { ok: false, error: e.message.slice(0, 300) });
    throw e;
  } finally {
    entry.ms = Date.now() - start;
    try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch {}
  }
}

const CRITIQUE_FRAME = 'You are reviewing work for another AI agent. Do not edit files. ' +
  'List concrete problems (bugs, wrong assumptions, missing cases), most severe first, citing files where relevant. ' +
  'Say plainly if it looks right. Be brief.\n\n';

const WRITE_PROP = { type: 'boolean', description: 'Let this backend edit files in the workspace. Default false (read-only). Only one agent should be writing at a time.' };
const TOOLS = [
  {
    name: 'ask_local',
    description: 'Free. Ask the local Qwen model on the homelab GPU. It cannot read files, so put everything it needs in the prompt. ' +
      'Use for drafts, summaries, boilerplate, log triage and other cheap work before escalating.',
    inputSchema: { type: 'object', required: ['prompt'], properties: {
      prompt: { type: 'string' }, system: { type: 'string', description: 'Optional system prompt.' } } },
    handler: (a) => call('local', a),
  },
  {
    name: 'ask_claude',
    description: 'Spends Claude subscription quota. Runs Claude Code headless in this workspace; it can read the repo itself, so pass a focused question and file paths, not file contents. ' +
      'Use for planning, architecture and hard bugs, or after the local model failed twice. Starts with no memory of this chat.',
    inputSchema: { type: 'object', required: ['prompt'], properties: {
      prompt: { type: 'string' },
      model: { type: 'string', enum: ['sonnet', 'opus', 'haiku'], description: 'Default sonnet. Use opus only for planning or very hard problems.' },
      write: WRITE_PROP } },
    handler: (a) => call('claude', a),
  },
  {
    name: 'ask_codex',
    description: 'Spends ChatGPT subscription quota. Runs Codex headless in this workspace; it can read the repo itself, so pass a focused question and file paths. ' +
      'Use as an alternative to ask_claude, especially when Claude quota is low. Starts with no memory of this chat.',
    inputSchema: { type: 'object', required: ['prompt'], properties: {
      prompt: { type: 'string' },
      effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Reasoning effort. Default medium.' },
      write: WRITE_PROP } },
    handler: (a) => call('codex', a),
  },
  {
    name: 'critique',
    description: 'Spends both Claude and ChatGPT quota. Claude and Codex review the same plan or change in parallel, read-only, and both reviews come back for you to merge. ' +
      'Use at checkpoints only: a finished plan or a final diff, not every turn.',
    inputSchema: { type: 'object', required: ['subject'], properties: {
      subject: { type: 'string', description: 'What to review: the plan text, or which files/diff to look at (e.g. "the uncommitted diff" or "fusion/server.mjs").' } } },
    handler: async ({ subject }) => {
      const prompt = CRITIQUE_FRAME + subject;
      const [c, x] = await Promise.allSettled([call('claude', { prompt }), call('codex', { prompt })]);
      const show = (name, r) => `## ${name}\n${r.status === 'fulfilled' ? r.value : `(failed: ${r.reason.message})`}`;
      return `${show('Claude review', c)}\n\n${show('Codex review', x)}`;
    },
  },
];

function report() {
  if (!existsSync(LOG)) return console.log(`No usage yet (${LOG}).`);
  const since = Date.now() - Number(process.argv[3] || 7) * 86_400_000;
  const rows = {};
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    if (Date.parse(e.ts) < since) continue;
    const r = (rows[e.backend] ||= { calls: 0, failed: 0, in: 0, out: 0, cost: 0, ms: 0 });
    r.calls++; r.failed += e.ok ? 0 : 1; r.in += e.in || 0; r.out += e.out || 0; r.cost += e.cost_usd || 0; r.ms += e.ms;
  }
  console.log(`Last ${process.argv[3] || 7} days (${LOG})`);
  console.table(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, {
    calls: r.calls, failed: r.failed, 'tokens in': r.in, 'tokens out': r.out,
    'API-price equiv $': r.cost ? r.cost.toFixed(2) : '-', 'avg s': (r.ms / r.calls / 1000).toFixed(1),
  }])));
}

function serve() {
  // Backends started by this server must not reach it again, or one call could fan out into many.
  const tools = process.env.FUSION_CHILD ? [] : TOOLS;
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const methods = {
    initialize: (p) => ({
      protocolVersion: p?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fusion', version: '0.1.0' },
    }),
    ping: () => ({}),
    'tools/list': () => ({ tools: tools.map(({ handler, ...t }) => t) }),
    'tools/call': async (p) => {
      const tool = tools.find((t) => t.name === p?.name);
      if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${p?.name}` }] };
      try {
        return { content: [{ type: 'text', text: await tool.handler(p.arguments || {}) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e.message }] };
      }
    },
  };
  createInterface({ input: process.stdin }).on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (msg.id === undefined) return; // notification
    const fn = methods[msg.method];
    if (!fn) return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    try { send({ id: msg.id, result: await fn(msg.params) }); }
    catch (e) { send({ id: msg.id, error: { code: -32603, message: e.message } }); }
  });
}

if (process.argv[2] === 'report') report(); else serve();
