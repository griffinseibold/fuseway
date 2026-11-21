// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../bin/loadout.mjs', import.meta.url).pathname;
const loadout = (...args) => {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
};
const repo = () => mkdtempSync(join(tmpdir(), 'loadout-test-'));
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

test('init keeps what an existing repo already has', () => {
  const dir = repo();
  writeFileSync(join(dir, 'AGENTS.md'), '# Our agents\n\nNever touch prod.\n');
  writeFileSync(join(dir, 'CLAUDE.md'), 'Use pnpm.\n');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }));
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  loadout('init', dir, '--no-pstack');

  const agents = read(dir, 'AGENTS.md');
  assert.match(agents, /Never touch prod\./);
  assert.match(agents, /fusion/);
  assert.match(read(dir, 'CLAUDE.md'), /Use pnpm\.[\s\S]*@AGENTS\.md/);
  assert.deepEqual(Object.keys(JSON.parse(read(dir, '.mcp.json')).mcpServers).sort(), ['db', 'fusion']);
  assert.match(read(dir, '.gitignore'), /^dist\/\n[\s\S]*\.agents\/usage\.jsonl/);
  assert.ok(existsSync(join(dir, '.agents/fusion/server.mjs')));
  assert.ok(!existsSync(join(dir, '.agents/skills')), '--no-pstack installs no skills');
});

test('init twice changes nothing the second time', () => {
  const dir = repo();
  writeFileSync(join(dir, 'AGENTS.md'), '# Ours\n');
  loadout('init', dir, '--no-pstack');
  const second = loadout('init', dir, '--no-pstack');
  const changed = second.split('\n').filter((l) => /^\s+(created|updated)\s/.test(l));
  assert.deepEqual(changed, []);
  assert.equal(read(dir, 'AGENTS.md').split('<!-- loadout:begin -->').length, 2, 'exactly one loadout block');
});

test('init in an empty repo starts from the template, with skills linked', () => {
  const dir = repo();
  const out = loadout('init', dir);
  assert.match(read(dir, 'AGENTS.md'), /\*\*Project:\*\* _TODO/);
  assert.match(read(dir, 'CLAUDE.md'), /^@AGENTS\.md/);
  assert.ok(lstatSync(join(dir, '.claude/skills')).isSymbolicLink());
  assert.ok(existsSync(join(dir, '.claude/skills/poteto-mode/SKILL.md')));
  assert.match(out, /fill in the Project and Commands/);
});

test('init leaves a commented .vscode/mcp.json alone and says what to add', () => {
  const dir = repo();
  mkdirSync(join(dir, '.vscode'));
  writeFileSync(join(dir, '.vscode/mcp.json'), '{\n  // ours\n  "servers": {}\n}\n');
  const out = loadout('init', dir, '--no-pstack');
  assert.match(read(dir, '.vscode/mcp.json'), /\/\/ ours/);
  assert.match(out, /skipped .*\.vscode\/mcp\.json|\.vscode\/mcp\.json.*skipped|skipped \(not plain JSON/);
});

test('model --recommend picks a tier from VRAM and RAM', () => {
  const at = (vram, ram) => loadout('model', '--recommend', '--vram', String(vram), '--ram', String(ram));
  assert.match(at(16, 48), /Qwen3\.6-35B-A3B-UD-IQ3_XXS[\s\S]*Measured: RX 6800/);
  assert.match(at(24, 64), /UD-IQ4_XS/);
  assert.match(at(12, 32), /IQ3_XXS[\s\S]*--n-cpu-moe 12/);
  assert.match(at(12, 16), /Qwen3-8B/);
  assert.match(at(4, 8), /no local model/);
  assert.match(loadout('model', '--recommend', '--vram', '16', '--ram', '48', '--gpu', 'nvidia'), /--gpus all[\s\S]*server-cuda-b10731/);
});
