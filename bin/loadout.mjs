#!/usr/bin/env node
// loadout: one agent setup for every repo, and one local model per machine.
//   loadout init [dir] [--no-pstack]     add the setup to a repo (default: current directory); safe to rerun
//   loadout model [--url URL] [--ctx N]  find, check and configure this machine's local model server
//   loadout model --recommend [--vram GiB] [--ram GiB]   recommend a model for this (or a hypothetical) machine
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform, arch, totalmem } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOADOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_CONFIG = join(homedir(), '.config', 'loadout', 'local.json');
const BEGIN = '<!-- loadout:begin -->';
const END = '<!-- loadout:end -->';
const MANAGED = '# managed by loadout: rerun `loadout model` to update';

const read = (p) => readFileSync(p, 'utf8');
const template = (name) => read(join(LOADOUT, 'template', name));
const which = (name) => (process.env.PATH || '').split(delimiter).map((d) => join(d, name)).find(existsSync);

// ---------- init ----------

function report(rel, status) { console.log(`  ${status.padEnd(10)} ${rel}`); }

function writeFile(root, rel, content) {
  const path = join(root, rel);
  const before = existsSync(path) ? read(path) : null;
  if (before === content) return report(rel, 'unchanged');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  report(rel, before === null ? 'created' : 'updated');
}

function withBlock(text, block) {
  const wrapped = `${BEGIN}\n${block.trim()}\n${END}`;
  const i = text.indexOf(BEGIN), j = text.indexOf(END);
  if (i >= 0 && j > i) return text.slice(0, i) + wrapped + text.slice(j + END.length);
  return text.trim() ? `${text.replace(/\s*$/, '')}\n\n${wrapped}\n` : `${wrapped}\n`;
}

// Puts `block` between loadout markers in an existing file; a new file gets `fresh`, or just the block.
function upsert(root, rel, block, fresh) {
  const path = join(root, rel);
  writeFile(root, rel, existsSync(path) ? withBlock(read(path), block) : fresh ?? withBlock('', block));
}

function mergeJson(root, rel, merge) {
  const path = join(root, rel);
  let data = {};
  if (existsSync(path)) {
    try { data = JSON.parse(read(path)); } catch {
      return report(rel, `skipped (not plain JSON; add by hand: ${JSON.stringify(merge({}))})`);
    }
  }
  writeFile(root, rel, JSON.stringify(merge(data), null, 2) + '\n');
}

function copyOwned(root, rel) {
  if (resolve(root) === LOADOUT) return report(rel, 'unchanged');
  writeFile(root, rel, read(join(LOADOUT, rel)));
}

function linkSkills(root, rel) {
  const path = join(root, rel);
  let stat;
  try { stat = lstatSync(path); } catch {}
  if (!stat) { mkdirSync(dirname(path), { recursive: true }); symlinkSync('../.agents/skills', path); return report(rel, 'created'); }
  if (stat.isSymbolicLink() && readlinkSync(path) === '../.agents/skills') return report(rel, 'unchanged');
  report(rel, 'skipped (exists and is not a link to .agents/skills)');
}

function init(args) {
  const root = resolve(args.positional[0] || '.');
  if (!existsSync(root)) throw new Error(`No such directory: ${root}`);
  console.log(`loadout init ${root}`);
  const block = template('agents-block.md');

  upsert(root, 'AGENTS.md', block, template('AGENTS.md').replace('{{LOADOUT_BLOCK}}', `${BEGIN}\n${block.trim()}\n${END}`));
  const claude = join(root, 'CLAUDE.md');
  if (existsSync(claude) && /^@AGENTS\.md\s*$/m.test(read(claude))) report('CLAUDE.md', 'unchanged');
  else upsert(root, 'CLAUDE.md', '@AGENTS.md', template('CLAUDE.md'));
  upsert(root, '.github/copilot-instructions.md', template('copilot-instructions.md'));
  if (existsSync(join(root, '.agents/context/index.md'))) report('.agents/context/index.md', 'unchanged');
  else writeFile(root, '.agents/context/index.md', template('context-index.md'));

  for (const rel of ['.agents/fusion/server.mjs', '.agents/fusion/smoke.mjs', '.agents/tasks/refresh-context.md']) copyOwned(root, rel);

  if (!args.flags['no-pstack']) {
    const src = join(LOADOUT, '.agents/skills');
    if (resolve(root) === LOADOUT) report('.agents/skills/', 'unchanged');
    else {
      const before = existsSync(join(root, '.agents/skills/PSTACK_VERSION')) ? read(join(root, '.agents/skills/PSTACK_VERSION')) : null;
      cpSync(src, join(root, '.agents/skills'), { recursive: true });
      report('.agents/skills/', before === null ? 'created' : before === read(join(src, 'PSTACK_VERSION')) ? 'unchanged' : 'updated');
    }
    linkSkills(root, '.claude/skills');
    linkSkills(root, '.github/skills');
  }

  const fusion = { command: 'node', args: ['.agents/fusion/server.mjs'] };
  mergeJson(root, '.mcp.json', (d) => ({ ...d, mcpServers: { ...d.mcpServers, fusion } }));
  const vsMcp = join(root, '.vscode/mcp.json');
  if (existsSync(vsMcp) && read(vsMcp).includes('"fusion"')) report('.vscode/mcp.json', 'unchanged');
  else mergeJson(root, '.vscode/mcp.json', (d) => ({ ...d, servers: { ...d.servers,
    fusion: { type: 'stdio', command: 'node', args: ['${workspaceFolder}/.agents/fusion/server.mjs'] } } }));
  mergeJson(root, '.vscode/extensions.json', (d) => ({ ...d, recommendations: [...new Set([...(d.recommendations || []),
    'anthropic.claude-code', 'openai.chatgpt'])] }));

  const gitignore = join(root, '.gitignore');
  const ignored = existsSync(gitignore) ? read(gitignore) : '';
  const missing = ['.agents/usage.jsonl', '.agents/context/handoff.md', '*.gguf'].filter((l) => !ignored.split('\n').includes(l));
  if (missing.length) writeFile(root, '.gitignore', `${ignored.replace(/\s*$/, '')}${ignored ? '\n' : ''}${missing.join('\n')}\n`);
  else report('.gitignore', 'unchanged');

  console.log('\nThis machine:');
  console.log(`  claude     ${which('claude') || 'not found: fusion ask_claude will fail'}`);
  console.log(`  codex      ${which('codex') || (existsSync('/usr/lib/chatgpt/resources/codex') ? '/usr/lib/chatgpt/resources/codex (ChatGPT app)' : 'not found: fusion ask_codex will fail')}`);
  console.log(`  local LLM  ${existsSync(LOCAL_CONFIG) ? JSON.parse(read(LOCAL_CONFIG)).url : 'not configured: run `loadout model`'}`);
  if (/_TODO: one sentence\._/.test(read(join(root, 'AGENTS.md')))) console.log('\nNext: fill in the Project and Commands sections of AGENTS.md.');
}

// ---------- model ----------

const CANDIDATES = [
  ['homelab', 'http://llm.localhost:8080/v1'],
  ['llama-server', 'http://localhost:8080/v1'],
  ['Ollama', 'http://localhost:11434/v1'],
  ['LM Studio', 'http://localhost:1234/v1'],
  ['vLLM', 'http://localhost:8000/v1'],
];

async function getJson(url, init = {}, ms = 3000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function listModels(url) {
  try { return (await getJson(`${url}/models`)).data.map((m) => m.id); } catch { return null; }
}

async function contextSize(url) {
  try { // llama-server
    const p = await getJson(`${url.replace(/\/v1$/, '')}/props`);
    return p.default_generation_settings?.n_ctx || p.n_ctx || null;
  } catch { return null; }
}

async function toolCallWorks(url, model) {
  const r = await getJson(`${url}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get the current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }] }),
  }, 300_000);
  const call = r.choices?.[0]?.message?.tool_calls?.[0]?.function;
  let args = {};
  try { args = JSON.parse(call?.arguments || '{}'); } catch {}
  return { ok: call?.name === 'get_weather' && 'city' in args, tokensPerSecond: r.timings?.predicted_per_second };
}

function hardware(overrides) {
  const ramGiB = overrides.ram ? Number(overrides.ram) : totalmem() / 2 ** 30;
  let gpu = null;
  if (overrides.vram) gpu = { vendor: overrides.gpu || 'amd', vramGiB: Number(overrides.vram) };
  else if (platform() === 'darwin' && arch() === 'arm64') gpu = { vendor: 'apple', vramGiB: ramGiB * 0.65 };
  else {
    try {
      const out = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      gpu = { vendor: 'nvidia', vramGiB: Math.max(...out.trim().split('\n').map(Number)) / 1024 };
    } catch {}
    if (!gpu && existsSync('/sys/class/drm')) {
      for (const card of readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c))) {
        const dev = `/sys/class/drm/${card}/device`;
        try {
          const vram = Number(read(`${dev}/mem_info_vram_total`)) / 2 ** 30;
          const vendor = read(`${dev}/vendor`).trim() === '0x1002' ? 'amd' : 'other';
          if (!gpu || vram > gpu.vramGiB) gpu = { vendor, vramGiB: vram };
        } catch {}
      }
    }
  }
  return { gpu, ramGiB };
}

function recommend(hw) {
  const { tiers, llamaCppBuild } = JSON.parse(read(join(LOADOUT, 'local-llm/models.json')));
  const vram = hw.gpu?.vramGiB || 0;
  const tier = tiers.find((t) => vram >= t.minVramGiB && hw.ramGiB >= (t.minRamGiB || 0));
  console.log(`Hardware: ${hw.gpu ? `${hw.gpu.vendor} GPU, ${vram.toFixed(1)} GiB usable VRAM` : 'no GPU found'}, ${hw.ramGiB.toFixed(0)} GiB RAM`);
  if (!tier) {
    console.log('\nRecommendation: no local model. Nothing useful fits; let the frontier tools do everything, and use');
    console.log('Claude Haiku (ask_claude with model "haiku") for the cheap jobs.');
    return;
  }
  console.log(`\nRecommendation: ${tier.model} (${tier.file}, ${tier.sizeGB} GB), ${tier.ctx / 1024}K context`);
  console.log(`  ${tier.note}`);
  console.log(`  ${tier.measured ? `Measured: ${tier.measured}` : 'Not benchmarked on this tier yet: run local-llm/bench.sh after setup.'}`);
  const flags = [`--alias ${tier.alias}`, '-ngl 99', `-c ${tier.ctx}`, '-fa on -ctk q8_0 -ctv q8_0 --jinja', ...tier.args].join(' ');
  if (existsSync(join(homedir(), 'models', tier.file))) console.log(`\n1. Download: already in ~/models/${tier.file}`);
  else {
    console.log('\n1. Download:');
    console.log(`   mkdir -p ~/models && curl -L -C - -o ~/models/${tier.file} ${tier.url}`);
    console.log(`   echo "${tier.sha256}  $HOME/models/${tier.file}" | sha256sum -c`);
  }
  console.log('\n2. Run (one server per GPU; stop any other model server first):');
  const docker = (image, gpuFlags) => `   docker run -d --name llama-server --restart unless-stopped ${gpuFlags}-v ~/models:/models:ro \\\n     -p 127.0.0.1:8080:8080 ghcr.io/ggml-org/llama.cpp:${image}-${llamaCppBuild} \\\n     -m /models/${tier.file} ${flags} --host 0.0.0.0 --port 8080`;
  if (hw.gpu?.vendor === 'apple') console.log(`   brew install llama.cpp\n   llama-server -m ~/models/${tier.file} ${flags} --port 8080`);
  else if (hw.gpu?.vendor === 'nvidia') console.log(docker('server-cuda', '--gpus all '));
  else if (hw.gpu?.vendor === 'amd') console.log(docker('server-vulkan', '--device /dev/dri '));
  else console.log(docker('server', '').replace(' -ngl 99', ''));
  console.log('\n3. Configure every tool for it:\n   loadout model --url http://localhost:8080/v1');
}

function writeCodexProfile(local) {
  const dir = join(homedir(), '.codex');
  if (!existsSync(dir)) return console.log('  codex      skipped (~/.codex not found)');
  const path = join(dir, 'local.config.toml');
  if (existsSync(path) && !read(path).includes(MANAGED)) return console.log(`  codex      skipped (${path} exists and is not managed by loadout)`);
  writeFileSync(path, `${MANAGED}\n# Use with: codex --profile local\nmodel_provider = "loadout-local"\nmodel = ${JSON.stringify(local.model)}\n\n` +
    `[model_providers.loadout-local]\nname = "Local model (loadout)"\nbase_url = ${JSON.stringify(local.url)}\nwire_api = "responses"\n`);
  console.log(`  codex      ${path} (codex --profile local)`);
}

function writeVsCodeModel(local) {
  const dirs = [join(homedir(), '.config/Code/User'), join(homedir(), '.config/Code - Insiders/User'),
    join(homedir(), 'Library/Application Support/Code/User'), join(homedir(), 'Library/Application Support/Code - Insiders/User')];
  const found = dirs.filter(existsSync);
  if (!found.length) return console.log('  vscode     skipped (no VS Code user folder found)');
  for (const dir of found) {
    const path = join(dir, 'chatLanguageModels.json');
    let groups = [];
    if (existsSync(path)) {
      try { groups = JSON.parse(read(path)); } catch { console.log(`  vscode     skipped (${path} is not plain JSON)`); continue; }
    }
    const group = { name: 'Loadout local', vendor: 'customendpoint', apiType: 'chat-completions', models: [{
      id: local.model, name: `${local.model} (local)`, url: local.url, toolCalling: local.toolCalling, vision: false,
      thinking: true, contextWindow: local.contextWindow, maxOutputTokens: local.maxOutputTokens }] };
    writeFileSync(path, JSON.stringify([...groups.filter((g) => g.name !== 'Loadout local'), group], null, 2) + '\n');
    console.log(`  vscode     ${path} (model picker: ${group.models[0].name})`);
  }
}

async function model(args) {
  const f = args.flags;
  if (f.recommend) return recommend(hardware(f));

  let url = f.url?.replace(/\/$/, '');
  let models;
  if (url) {
    models = await listModels(url);
    if (!models) throw new Error(`No OpenAI-compatible server answered at ${url}/models`);
  } else {
    console.log('Looking for a local model server...');
    for (const [name, candidate] of CANDIDATES) {
      const found = await listModels(candidate);
      console.log(`  ${found ? 'found  ' : 'nothing'} ${name.padEnd(12)} ${candidate}${found ? `  ${found.join(', ')}` : ''}`);
      if (found && !url) { url = candidate; models = found; }
    }
    if (!url) {
      console.log('\nNo server found. If you have one elsewhere, run: loadout model --url http://host:port/v1\n');
      return recommend(hardware(f));
    }
  }
  const id = f.model || models[0];
  console.log(`\nChecking ${id} at ${url} (the first request may wait for the model to load)...`);
  const ctx = Number(f.ctx) || await contextSize(url);
  const tools = await toolCallWorks(url, id).catch((e) => ({ ok: false, error: e.message }));
  console.log(`  context    ${ctx || 'unknown, assuming 32768 (pass --ctx N to set it)'}`);
  console.log(`  tool calls ${tools.ok ? 'work' : `FAILED${tools.error ? ` (${tools.error})` : ''}: agent mode will not work with this server (llama-server needs --jinja)`}`);
  if (tools.tokensPerSecond) console.log(`  generation ${tools.tokensPerSecond.toFixed(0)} tokens/s`);
  if (url.includes(':11434')) console.log('  note       Ollama defaults to a small context; raise num_ctx for agent work.');

  const contextWindow = ctx || 32768;
  const local = { url, model: id, contextWindow, maxOutputTokens: Math.min(8192, Math.floor(contextWindow / 4)),
    toolCalling: tools.ok, checkedAt: new Date().toISOString() };
  mkdirSync(dirname(LOCAL_CONFIG), { recursive: true });
  writeFileSync(LOCAL_CONFIG, JSON.stringify(local, null, 2) + '\n');
  console.log('\nConfigured:');
  console.log(`  loadout    ${LOCAL_CONFIG} (fusion ask_local reads this)`);
  writeCodexProfile(local);
  writeVsCodeModel(local);
}

// ---------- main ----------

function parse(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.positional.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    out.flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') && !['recommend', 'no-pstack'].includes(k) ? argv[++i] : true);
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { init, model };
if (!commands[cmd]) {
  console.log(read(fileURLToPath(import.meta.url)).split('\n').slice(1, 6).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 2 : 0);
}
try { await commands[cmd](parse(rest)); } catch (e) { console.error(`loadout ${cmd}: ${e.message}`); process.exit(1); }
