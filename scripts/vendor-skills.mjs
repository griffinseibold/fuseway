#!/usr/bin/env node
// Copies third-party skills into .agents/skills/ at a pinned upstream commit, with their license.
//   node scripts/vendor-skills.mjs            fetch each source's default branch and record its commit
//   node scripts/vendor-skills.mjs --locked   refetch the commits already recorded in VENDORED.json
// Each skill must be a self-contained folder: one that links outside itself would break when installed alone.
// Review the diff (and run the skill-inspector skill on new ones) before committing.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, '.agents/skills');
const LOCK = join(SKILLS, 'VENDORED.json');

// name: folder in .agents/skills; repo: GitHub owner/name; path: the skill folder upstream.
const SOURCES = [
  { name: 'skill-inspector', repo: 'NVIDIA/SkillSpector', path: 'skills/skill-inspector' },
  { name: 'security-audit', repo: 'cloudflare/security-audit-skill', path: 'skills/security-audit' },
  { name: 'debugging-and-error-recovery', repo: 'addyosmani/agent-skills', path: 'skills/debugging-and-error-recovery' },
  { name: 'api-and-interface-design', repo: 'addyosmani/agent-skills', path: 'skills/api-and-interface-design' },
  { name: 'ci-cd-and-automation', repo: 'addyosmani/agent-skills', path: 'skills/ci-cd-and-automation' },
  { name: 'frontend-ui-engineering', repo: 'addyosmani/agent-skills', path: 'skills/frontend-ui-engineering' },
];

const git = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
};
const walk = (dir) => readdirSync(dir).flatMap((f) => statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]);

// Markdown links and paths that leave the skill folder, e.g. ](../../references/x.md).
function escapes(dir) {
  const out = [];
  for (const file of walk(dir).filter((f) => /\.(md|txt)$/i.test(f))) {
    for (const [, target] of readFileSync(file, 'utf8').matchAll(/\]\(([^)\s#]+)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const rel = relative(dir, resolve(dirname(file), target));
      if (rel.startsWith('..')) out.push(`${relative(dir, file)} → ${target}`);
    }
  }
  return out;
}

const locked = process.argv.includes('--locked');
const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : {};
const next = {};
const clones = new Map();
let failed = false;
try {
  for (const s of SOURCES) {
    const want = locked ? lock[s.name]?.commit : null;
    if (locked && !want) throw new Error(`${s.name} has no recorded commit; run without --locked first`);
    const key = `${s.repo}@${want || 'HEAD'}`;
    if (!clones.has(key)) {
      const dir = mkdtempSync(join(tmpdir(), 'fuseway-vendor-'));
      git(['clone', '--quiet', ...(want ? [] : ['--depth', '1']), `https://github.com/${s.repo}.git`, dir]);
      if (want) git(['checkout', '--quiet', want], dir);
      clones.set(key, { dir, commit: git(['rev-parse', 'HEAD'], dir) });
    }
    const { dir, commit } = clones.get(key);
    const src = join(dir, s.path);
    if (!existsSync(join(src, 'SKILL.md'))) { console.error(`✗ ${s.name}: no SKILL.md at ${s.repo}/${s.path}`); failed = true; continue; }
    const bad = escapes(src);
    if (bad.length) { console.error(`✗ ${s.name}: links outside its folder, skipped:\n  ${bad.join('\n  ')}`); failed = true; continue; }
    const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find((f) => existsSync(join(dir, f)));
    if (!license) { console.error(`✗ ${s.name}: ${s.repo} has no LICENSE file, skipped`); failed = true; continue; }
    const dest = join(SKILLS, s.name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    if (!existsSync(join(dest, 'LICENSE'))) cpSync(join(dir, license), join(dest, 'LICENSE'));
    next[s.name] = { repo: s.repo, path: s.path, commit };
    console.log(`✓ ${s.name}  ${s.repo}@${commit.slice(0, 12)}`);
  }
} finally {
  for (const { dir } of clones.values()) rmSync(dir, { recursive: true, force: true });
}
writeFileSync(LOCK, JSON.stringify({ ...lock, ...next }, null, 2) + '\n');
process.exit(failed ? 1 : 0);
