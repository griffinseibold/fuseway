#!/usr/bin/env node
// fuseway: one agent setup for every repo, and one local model per machine.
//   fuseway init [dir] [--skills pstack|superpowers|none]   add the setup to a repo (default: here, with pstack); safe to rerun
//   fuseway model [--url URL] [--ctx N]  find, check and configure this machine's local model server
//   fuseway model --recommend [--vram GiB] [--ram GiB]   recommend a model for this (or a hypothetical) machine
//   fuseway model --install [--yes] [--dry-run]           use a running server, or download and start the recommended one
//   fuseway extension                    build and install the @fuseway VS Code chat participant
//   fuseway setup                        one-time machine setup: PATH, local model, extension, then doctor
//   fuseway company init|status|run <mission.json>|challenge <mission.json>|stop <run-id>
//   fuseway doctor [--json]              check the CLIs, their sign-ins and the local model
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';
import { homedir, platform, arch, tmpdir, totalmem } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FUSEWAY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_CONFIG = join(homedir(), '.config', 'fuseway', 'local.json');
const BEGIN = '<!-- fuseway:begin -->';
const END = '<!-- fuseway:end -->';
const MANAGED = '# managed by fuseway: rerun `fuseway model` to update';

const read = (p) => readFileSync(p, 'utf8');
const template = (name) => read(join(FUSEWAY, 'template', name));
// On Windows, commands are found with one of PATHEXT's extensions (claude.cmd, codex.exe).
const EXTS = platform() === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').toLowerCase().split(';')] : [''];
const which = (name) => (process.env.PATH || '').split(delimiter).flatMap((d) => EXTS.map((e) => join(d, name + e))).find(existsSync);
const MODELS_DIR = join(homedir(), 'models');

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

// Puts `block` between fuseway markers in an existing file; a new file gets `fresh`, or just the block.
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
  if (resolve(root) === FUSEWAY) return report(rel, 'unchanged');
  writeFile(root, rel, read(join(FUSEWAY, rel)));
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
  console.log(`fuseway init ${root}`);
  const block = template('agents-block.md');

  upsert(root, 'AGENTS.md', block, template('AGENTS.md').replace('{{FUSEWAY_BLOCK}}', `${BEGIN}\n${block.trim()}\n${END}`));
  const claude = join(root, 'CLAUDE.md');
  if (existsSync(claude) && /^@AGENTS\.md\s*$/m.test(read(claude))) report('CLAUDE.md', 'unchanged');
  else upsert(root, 'CLAUDE.md', '@AGENTS.md', template('CLAUDE.md'));
  upsert(root, '.github/copilot-instructions.md', template('copilot-instructions.md'));
  if (existsSync(join(root, '.agents/context/index.md'))) report('.agents/context/index.md', 'unchanged');
  else writeFile(root, '.agents/context/index.md', template('context-index.md'));

  // Repo-owned: extra routing rules for @fuseway, added to its defaults (see .agents/context/extension.md in fuseway).
  if (existsSync(join(root, '.agents/routing.json'))) report('.agents/routing.json', 'unchanged');
  else writeFile(root, '.agents/routing.json', JSON.stringify({ frontierPaths: [], frontierKeywords: [], localKeywords: [] }, null, 2) + '\n');

  for (const rel of ['.agents/fusion/server.mjs', '.agents/fusion/smoke.mjs', '.agents/tasks/refresh-context.md']) copyOwned(root, rel);

  // Skills: pstack ships with fuseway (works offline); Superpowers (obra/superpowers, MIT) is cloned at install time.
  const skills = args.flags['no-pstack'] ? 'none' : args.flags.skills || 'pstack';
  if (!['pstack', 'superpowers', 'none'].includes(skills)) throw new Error(`--skills must be pstack, superpowers or none, not ${skills}`);
  if (skills !== 'none') {
    const stamp = skills === 'pstack' ? 'PSTACK_VERSION' : 'SUPERPOWERS_VERSION';
    const before = existsSync(join(root, '.agents/skills', stamp)) ? read(join(root, '.agents/skills', stamp)) : null;
    let src = join(FUSEWAY, '.agents/skills'), version, tmp;
    if (skills === 'superpowers') {
      tmp = join(tmpdir(), `fuseway-superpowers-${process.pid}`);
      const clone = spawnSync('git', ['clone', '--depth', '1', '--quiet', 'https://github.com/obra/superpowers.git', tmp], { encoding: 'utf8' });
      if (clone.status !== 0) throw new Error(`couldn't clone Superpowers: ${(clone.stderr || '').trim() || 'is git installed and are you online?'}`);
      src = join(tmp, 'skills');
      version = spawnSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() + '\n';
    } else version = read(join(src, 'PSTACK_VERSION'));
    if (resolve(root) === FUSEWAY && skills === 'pstack') report('.agents/skills/', 'unchanged');
    else {
      cpSync(src, join(root, '.agents/skills'), { recursive: true });
      if (skills === 'superpowers') {
        writeFileSync(join(root, '.agents/skills', stamp), version);
        cpSync(join(tmp, 'LICENSE'), join(root, '.agents/skills/SUPERPOWERS_LICENSE'));
        rmSync(tmp, { recursive: true, force: true });
        // The third-party skills fuseway routes to (scripts/vendor-skills.mjs) go with either skill set.
        const vendored = join(FUSEWAY, '.agents/skills/VENDORED.json');
        for (const name of existsSync(vendored) ? Object.keys(JSON.parse(read(vendored))) : [])
          cpSync(join(FUSEWAY, '.agents/skills', name), join(root, '.agents/skills', name), { recursive: true });
      }
      report(`.agents/skills/ (${skills})`, before === null ? 'created' : before === version ? 'unchanged' : 'updated');
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
  console.log(`  local LLM  ${existsSync(LOCAL_CONFIG) ? JSON.parse(read(LOCAL_CONFIG)).url : 'not configured: run `fuseway model`'}`);
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

// What to run for this hardware: { hw, tier, image, gpuArgs, serverArgs, native } or { hw, tier: null }.
function serverPlan(hw) {
  const { tiers, llamaCppBuild } = JSON.parse(read(join(FUSEWAY, 'local-llm/models.json')));
  const vram = hw.gpu?.vramGiB || 0;
  const tier = tiers.find((t) => vram >= t.minVramGiB && hw.ramGiB >= (t.minRamGiB || 0));
  if (!tier) return { hw, tier: null };
  const vendor = hw.gpu?.vendor;
  const serverArgs = ['--alias', tier.alias, ...(vendor && vendor !== 'other' ? ['-ngl', '99'] : []), '-c', String(tier.ctx),
    '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '--jinja', ...tier.args];
  const [image, gpuArgs] = { nvidia: ['server-cuda', ['--gpus', 'all']], amd: ['server-vulkan', ['--device', '/dev/dri']] }[vendor] || ['server', []];
  return { hw, tier, native: vendor === 'apple', image: `ghcr.io/ggml-org/llama.cpp:${image}-${llamaCppBuild}`, gpuArgs, serverArgs };
}

const CONTAINER = 'fuseway-llm';
const dockerArgs = (p) => ['run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped', ...p.gpuArgs, '-v', `${MODELS_DIR}:/models:ro`,
  '-p', '127.0.0.1:8080:8080', p.image, '-m', `/models/${p.tier.file}`, ...p.serverArgs, '--host', '0.0.0.0', '--port', '8080'];

function describe(p) {
  const { hw, tier } = p;
  console.log(`Hardware: ${hw.gpu ? `${hw.gpu.vendor} GPU, ${hw.gpu.vramGiB.toFixed(1)} GiB usable VRAM` : 'no GPU found'}, ${hw.ramGiB.toFixed(0)} GiB RAM`);
  if (!tier) {
    console.log('\nRecommendation: no local model. Nothing useful fits; let the frontier tools do everything, and use');
    console.log('Claude Haiku (ask_claude with model "haiku") for the cheap jobs.');
    return;
  }
  console.log(`\nRecommendation: ${tier.model} (${tier.file}, ${tier.sizeGB} GB), ${tier.ctx / 1024}K context`);
  console.log(`  ${tier.note}`);
  console.log(`  ${tier.measured ? `Measured: ${tier.measured}` : 'Not benchmarked on this tier yet: run local-llm/bench.sh after setup.'}`);
}

function recommend(hw) {
  const p = serverPlan(hw);
  describe(p);
  if (!p.tier) return;
  const { tier } = p;
  if (existsSync(join(MODELS_DIR, tier.file))) console.log(`\n1. Download: already in ~/models/${tier.file}`);
  else {
    console.log('\n1. Download:');
    console.log(`   mkdir -p ~/models && curl -L -C - -o ~/models/${tier.file} ${tier.url}`);
    console.log(`   echo "${tier.sha256}  $HOME/models/${tier.file}" | sha256sum -c`);
  }
  console.log('\n2. Run (one server per GPU; stop any other model server first):');
  if (p.native) console.log(`   brew install llama.cpp\n   llama-server -m ~/models/${tier.file} ${p.serverArgs.join(' ')} --port 8080`);
  else console.log(`   docker ${dockerArgs(p).join(' ').replace(MODELS_DIR, '~/models')}`);
  console.log('\n3. Configure every tool for it:\n   fuseway model --url http://localhost:8080/v1');
  console.log('\nOr do all three: fuseway model --install');
}

const fileSha = (path) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(path).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
});

// Resumes a .partial file, verifies the checksum, then renames it into place.
export { serverPlan, dockerArgs };

export async function download(url, dest, sha256, log = console.log) {
  if (existsSync(dest)) {
    log(`  checking ${dest}…`);
    if (await fileSha(dest) === sha256) return log('  already downloaded and verified');
    throw new Error(`${dest} exists but its checksum doesn't match; move it aside and rerun`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.partial`;
  let have = existsSync(part) ? statSync(part).size : 0;
  const res = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {} });
  if (have && res.status !== 206) have = 0;
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} from ${url}`);
  const total = have + Number(res.headers.get('content-length') || 0);
  const out = createWriteStream(part, { flags: have ? 'a' : 'w' });
  let got = have, shown = -1;
  if (have) log(`  resuming at ${(have / 1e9).toFixed(1)} GB`);
  for await (const chunk of res.body) {
    if (!out.write(chunk)) await once(out, 'drain');
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 20) * 5 : -1;
    if (pct > shown) { shown = pct; log(`  ${pct}% (${(got / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB)`); }
  }
  await new Promise((resolve) => out.end(resolve));
  log('  verifying checksum…');
  if (await fileSha(part) !== sha256) { unlinkSync(part); throw new Error('checksum mismatch: the download was corrupted, rerun to fetch it again'); }
  renameSync(part, dest);
}

async function confirm(question, flags) {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) throw new Error('needs confirmation: rerun with --yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// Makes sure this machine has a local model: use one that's already running, or download and start one.
async function install(flags) {
  for (const [name, url] of CANDIDATES) {
    if (await listModels(url)) {
      console.log(`A model server is already running (${name}, ${url}); configuring it.\n`);
      return model({ positional: [], flags: { ...flags, url, install: undefined } });
    }
  }
  const p = serverPlan(hardware(flags));
  describe(p);
  if (!p.tier) return;
  const dest = join(MODELS_DIR, p.tier.file);
  if (p.native) {
    console.log(`\nOn a Mac, Docker can't reach the GPU, so run llama.cpp natively:\n  brew install llama.cpp\n  llama-server -m ${dest} ${p.serverArgs.join(' ')} --port 8080\nthen: fuseway model`);
    if (!existsSync(dest) && await confirm(`\nDownload the model now (${p.tier.sizeGB} GB to ~/models)?`, flags)) await download(p.tier.url, dest, p.tier.sha256);
    return;
  }
  if (!which('docker')) throw new Error('Docker runs the model server and is not installed: https://docs.docker.com/engine/install/ (then rerun)');
  const steps = [existsSync(dest) ? `use ~/models/${p.tier.file} (already downloaded)` : `download ${p.tier.sizeGB} GB to ~/models/${p.tier.file}`,
    `start a llama.cpp server in Docker (container "${CONTAINER}", port 8080, restarts with the machine)`, 'configure fusion, Codex and VS Code for it'];
  console.log(`\nThis will:\n${steps.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}`);
  if (flags['dry-run']) return console.log(`\nDry run. The server command would be:\n  docker ${dockerArgs(p).join(' ')}`);
  if (!(await confirm('\nGo ahead?', flags))) return console.log('Nothing changed.');
  console.log('\n1. Model');
  await download(p.tier.url, dest, p.tier.sha256);
  console.log('\n2. Server');
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  const run = spawnSync('docker', dockerArgs(p), { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`docker run failed: ${(run.stderr || run.stdout).trim()}`);
  process.stdout.write('  loading the model');
  const start = Date.now();
  while (!(await fetch('http://localhost:8080/health').then((r) => r.ok, () => false))) {
    if (Date.now() - start > 600_000) throw new Error(`the server didn't come up in 10 minutes: docker logs ${CONTAINER}`);
    const state = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { encoding: 'utf8' }).stdout.trim();
    if (state !== 'true') throw new Error(`the server stopped while loading: docker logs ${CONTAINER}`);
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(` ready in ${Math.round((Date.now() - start) / 1000)} s\n\n3. Configure`);
  await model({ positional: [], flags: { url: 'http://localhost:8080/v1' } });
}

function writeCodexProfile(local) {
  const dir = join(homedir(), '.codex');
  if (!existsSync(dir)) return console.log('  codex      skipped (~/.codex not found)');
  const path = join(dir, 'local.config.toml');
  if (existsSync(path) && !read(path).includes(MANAGED)) return console.log(`  codex      skipped (${path} exists and is not managed by fuseway)`);
  writeFileSync(path, `${MANAGED}\n# Use with: codex --profile local\nmodel_provider = "fuseway-local"\nmodel = ${JSON.stringify(local.model)}\n\n` +
    `[model_providers.fuseway-local]\nname = "Local model (fuseway)"\nbase_url = ${JSON.stringify(local.url)}\nwire_api = "responses"\n`);
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
    const group = { name: 'Fuseway local', vendor: 'customendpoint', apiType: 'chat-completions', models: [{
      id: local.model, name: `${local.model} (local)`, url: local.url, toolCalling: local.toolCalling, vision: false,
      thinking: true, contextWindow: local.contextWindow, maxOutputTokens: local.maxOutputTokens }] };
    writeFileSync(path, JSON.stringify([...groups.filter((g) => g.name !== 'Fuseway local'), group], null, 2) + '\n');
    console.log(`  vscode     ${path} (model picker: ${group.models[0].name})`);
  }
}

async function model(args) {
  const f = args.flags;
  if (f.recommend) return recommend(hardware(f));
  if (f.install) return install(f);

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
      console.log('\nNo server found. If you have one elsewhere, run: fuseway model --url http://host:port/v1\n');
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
  console.log(`  fuseway    ${LOCAL_CONFIG} (fusion ask_local reads this)`);
  writeCodexProfile(local);
  writeVsCodeModel(local);
}

// ---------- extension ----------

function extension() {
  const vsix = join(FUSEWAY, 'extension', 'fuseway.vsix');
  execFileSync(process.execPath, [join(FUSEWAY, 'extension', 'build.mjs'), vsix], { stdio: 'inherit' });
  const code = which('code') || which('code-insiders');
  if (!code) return console.log(`VS Code CLI not found. Install ${vsix} with "Extensions: Install from VSIX…".`);
  execFileSync(code, ['--install-extension', vsix, '--force'], { stdio: ['ignore', 'inherit', 'ignore'] });
  console.log('Installed. A new install is ready right away; an update loads after "Developer: Reload Window".');
  if (!existsSync(LOCAL_CONFIG)) console.log('No local model configured yet: run `fuseway model` so @fuseway can route to it.');
}

// ---------- doctor and setup ----------

const CODEX_BUNDLED = '/usr/lib/chatgpt/resources/codex';
// Some CLIs print status to stderr, so keep both streams.
const quiet = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
};

async function checks() {
  const out = [];
  // run: a command that fixes it, for `setup` and the extension's Set Up button (null when it needs a person).
  const add = (name, ok, detail, fix, run = null, optional = false) => out.push({ name, ok, detail, fix: ok ? null : fix, run: ok ? null : run, optional });
  const npm = which('npm');

  const claude = which('claude');
  if (!claude) add('Claude Code CLI', false, 'not installed', npm ? 'npm install -g @anthropic-ai/claude-code, then claude auth login' : 'install Node.js (it brings npm), then npm install -g @anthropic-ai/claude-code',
    npm ? 'npm install -g @anthropic-ai/claude-code && claude auth login' : null);
  else {
    let status = {};
    try { status = JSON.parse(quiet(claude, ['auth', 'status']).out); } catch {}
    add('Claude Code CLI', !!status.loggedIn, status.loggedIn ? `signed in (${status.authMethod})` : 'not signed in', 'claude auth login', `"${claude}" auth login`);
  }

  const codex = which('codex') || (existsSync(CODEX_BUNDLED) ? CODEX_BUNDLED : null);
  if (!codex) add('Codex CLI', false, 'not installed', npm ? 'npm install -g @openai/codex, then codex login' : 'install Node.js (it brings npm), then npm install -g @openai/codex',
    npm ? 'npm install -g @openai/codex && codex login' : null);
  else {
    const s = quiet(codex, ['login', 'status']);
    // Codex can print warnings first; the status is the line that mentions logging in.
    const line = s.out.split('\n').find((l) => /logged in|not logged/i.test(l)) || 'not signed in';
    add('Codex CLI', s.ok && /^\s*logged in/i.test(line), line.trim(), 'codex login', `"${codex}" login`);
  }

  const local = existsSync(LOCAL_CONFIG) ? JSON.parse(read(LOCAL_CONFIG)) : null;
  if (!local) add('Local model', false, 'not configured', 'fuseway model --install (or "Fuseway: Set Up Local Model" in VS Code)', 'fuseway model --install');
  else {
    const models = await listModels(local.url);
    add('Local model', !!models && local.toolCalling, models ? `${local.model} at ${local.url}${local.toolCalling ? '' : ', but tool calls failed'}` : `offline at ${local.url}`,
      models ? 'serve it with tool calling on (llama-server needs --jinja), then fuseway model' : 'start your model server (homelab: ./scripts/lab-mode.py llm --wait), or fuseway model --install');
  }
  const profile = join(homedir(), '.codex', 'local.config.toml');
  add('Codex local profile', existsSync(profile), existsSync(profile) ? profile : 'missing: @fuseway runs local work through it', 'fuseway model', local ? 'fuseway model' : null);

  const nodeVersion = quiet('node', ['--version']);
  const major = Number((nodeVersion.out.match(/v(\d+)/) || [])[1] || 0);
  add('Node 22+ on PATH', major >= 22, nodeVersion.ok ? nodeVersion.out.trim() : 'not found', 'install Node 22 or newer (only needed for the fusion MCP server in repos)', null, true);
  return out;
}

async function doctor(args) {
  const results = await checks();
  if (args.flags.json) return console.log(JSON.stringify(results));
  for (const c of results) console.log(`  ${c.ok ? 'ok  ' : c.optional ? 'warn' : 'FIX '}  ${c.name.padEnd(20)} ${c.detail}${c.fix ? `\n        → ${c.fix}` : ''}`);
  const missing = results.filter((c) => !c.ok && !c.optional).length;
  console.log(missing ? `\n${missing} thing(s) to fix.` : '\nAll set.');
}

async function setup(args) {
  const bin = join(homedir(), '.local', 'bin');
  const link = join(bin, 'fuseway');
  console.log('1. Command');
  if (existsSync(link) || which('fuseway')) console.log(`  ok    fuseway is on PATH (${which('fuseway') || link})`);
  else if ((process.env.PATH || '').split(delimiter).includes(bin)) { mkdirSync(bin, { recursive: true }); symlinkSync(join(FUSEWAY, 'bin', 'fuseway.mjs'), link); console.log(`  added ${link}`); }
  else console.log(`  skip  ${bin} is not on PATH; run this CLI as node ${join(FUSEWAY, 'bin', 'fuseway.mjs')}`);
  console.log('\n2. Local model');
  await install(args.flags).catch((e) => console.log(`  ${e.message}`));
  console.log('\n3. VS Code extension');
  if (existsSync(join(FUSEWAY, 'extension', 'build.mjs'))) extension();
  else console.log('  ok    running from the installed extension');
  console.log('\n4. Check');
  await doctor({ flags: {} });
  const fixable = (await checks()).filter((c) => !c.ok && c.run && !c.run.startsWith('fuseway '));
  if (fixable.length && await confirm(`\nRun the ${fixable.length} fix${fixable.length > 1 ? 'es' : ''} above now?`, args.flags)) {
    for (const c of fixable) { console.log(`\n$ ${c.run}`); spawnSync(c.run, { shell: true, stdio: 'inherit' }); }
    await doctor({ flags: {} });
  }
}

// ---------- main ----------

function parse(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.positional.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    out.flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') && !['recommend', 'no-pstack', 'json', 'install', 'yes', 'dry-run'].includes(k) ? argv[++i] : true);
  }
  return out;
}

// Run only as a command, not when imported (tests import download). argv[1] may be a symlink in ~/.local/bin.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const company = async args => {
    const { command } = await import('../company/cli.mjs');
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error('Company cancelled by SIGINT'));
    const terminate = () => controller.abort(new Error('Company cancelled by SIGTERM'));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    try {
      const output = await command(process.cwd(), args.positional[0], args.positional[1], { signal: controller.signal, onProgress: message => console.error(message) });
      console.log(output);
      if (['run','challenge'].includes(args.positional[0]) && JSON.parse(output).status !== 'completed') process.exitCode = controller.signal.aborted ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    }
  };
  const commands = { init, model, extension, setup, doctor, company };
  if (!commands[cmd]) {
    console.log(read(fileURLToPath(import.meta.url)).split('\n').slice(1).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 2 : 0);
  }
  try { await commands[cmd](parse(rest)); } catch (e) { console.error(`fuseway ${cmd}: ${e.message}`); process.exit(1); }
}
