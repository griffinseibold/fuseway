// Whole tasks for eval/run-tasks.mjs. Each one is a tiny Node repo: starting files, a spec, and a test file that
// decides success. The runner restores test.mjs before checking, so editing the tests can't pass a task.
// This is the test set: the router was tuned on extension/route-cases.json, never on these, and isn't changed
// while they're being scored. Each task's reference solution must pass its test (run-tasks.mjs --check-tests).
export const TASKS = [
  {
    id: 'slugify',
    // Reference solution: proves the test can pass. Never shown to agents.
    solution: { 'slug.mjs': `export function slugify(s) {\n  return s.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n` },
    prompt: 'Implement and export slugify(s) in slug.mjs: lowercase, remove accents (é becomes e), turn each run of characters that are not letters or digits into one "-", and strip leading and trailing "-".',
    files: { 'slug.mjs': 'export function slugify(s) {\n  // TODO\n}\n' },
    test: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { slugify } from './slug.mjs';
test('slugify', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Crème Brûlée  '), 'creme-brulee');
  assert.equal(slugify('a--b__c'), 'a-b-c');
  assert.equal(slugify('Déjà vu 2'), 'deja-vu-2');
  assert.equal(slugify(''), '');
});`,
  },
  {
    id: 'format-bytes',
    // Reference solution: proves the test can pass. Never shown to agents.
    solution: { 'bytes.mjs': `export function formatBytes(n) {\n  const units = ['B', 'KB', 'MB', 'GB', 'TB'];\n  let i = 0;\n  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }\n  return i === 0 ? \`\${n} B\` : \`\${Number(n.toFixed(1))} \${units[i]}\`;\n}\n` },
    prompt: 'Implement and export formatBytes(n) in bytes.mjs. Use 1024 steps and units B, KB, MB, GB, TB. Bytes are whole numbers ("1023 B"); larger units have one decimal, dropping ".0" ("1.5 KB", "1 MB").',
    files: { 'bytes.mjs': 'export function formatBytes(n) {\n  // TODO\n}\n' },
    test: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { formatBytes } from './bytes.mjs';
test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1048576), '1 MB');
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(formatBytes(1024 ** 4 * 2.25), '2.3 TB');
});`,
  },
  {
    id: 'pager-bug',
    // Reference solution: proves the test can pass. Never shown to agents.
    solution: { 'pager.mjs': `export function page(items, size, n) {\n  if (size <= 0) throw new Error('size must be positive');\n  const start = (n - 1) * size;\n  return items.slice(start, start + size);\n}\nexport function pageCount(items, size) {\n  return Math.ceil(items.length / size);\n}\nexport function hasPage(items, size, n) {\n  return n >= 1 && n <= pageCount(items, size);\n}\n` },
    prompt: 'The tests in test.mjs fail. Find the bug in pager.mjs and fix it.',
    files: { 'pager.mjs': `export function page(items, size, n) {
  if (size <= 0) throw new Error('size must be positive');
  const start = (n - 1) * size;
  return items.slice(start, start + size);
}
export function pageCount(items, size) {
  return Math.floor(items.length / size);
}
export function hasPage(items, size, n) {
  return n >= 1 && n <= pageCount(items, size);
}
` },
    test: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { page, pageCount, hasPage } from './pager.mjs';
test('pager', () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  assert.equal(pageCount(items, 3), 3);
  assert.equal(pageCount([], 3), 0);
  assert.deepEqual(page(items, 3, 3), [7]);
  assert.equal(hasPage(items, 3, 3), true);
  assert.equal(hasPage(items, 3, 4), false);
});`,
  },
  {
    id: 'csv-line',
    // Reference solution: proves the test can pass. Never shown to agents.
    solution: { 'csv.mjs': `export function parseCsvLine(line) {\n  const out = []; let cur = '', q = false;\n  for (let i = 0; i < line.length; i++) {\n    const ch = line[i];\n    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }\n    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;\n  }\n  out.push(cur);\n  return out;\n}\n` },
    prompt: 'Implement and export parseCsvLine(line) in csv.mjs. It returns the fields of one CSV line. Fields may be quoted with double quotes; a quoted field can contain commas, and "" inside quotes means a literal quote. Unquoted fields are returned as-is.',
    files: { 'csv.mjs': 'export function parseCsvLine(line) {\n  // TODO\n}\n' },
    test: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { parseCsvLine } from './csv.mjs';
test('parseCsvLine', () => {
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvLine('"a,b",c'), ['a,b', 'c']);
  assert.deepEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
  assert.deepEqual(parseCsvLine('a,,c'), ['a', '', 'c']);
  assert.deepEqual(parseCsvLine('""'), ['']);
  assert.deepEqual(parseCsvLine('x,"",y'), ['x', '', 'y']);
});`,
  },
  {
    id: 'merge-intervals',
    // Reference solution: proves the test can pass. Never shown to agents.
    solution: { 'intervals.mjs': `export function mergeIntervals(list) {\n  const out = [];\n  for (const [a, b] of [...list].map((x) => [...x]).sort((x, y) => x[0] - y[0])) {\n    const last = out[out.length - 1];\n    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);\n  }\n  return out;\n}\n` },
    prompt: 'Implement and export mergeIntervals(list) in intervals.mjs. It takes [start, end] pairs in any order and returns them merged and sorted by start. Overlapping or touching intervals merge ([1, 2] and [2, 3] become [1, 3]). Do not modify the input.',
    files: { 'intervals.mjs': 'export function mergeIntervals(list) {\n  // TODO\n}\n' },
    test: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { mergeIntervals } from './intervals.mjs';
test('mergeIntervals', () => {
  const input = [[8, 10], [1, 3], [2, 6], [15, 18], [6, 7]];
  assert.deepEqual(mergeIntervals(input), [[1, 7], [8, 10], [15, 18]]);
  assert.deepEqual(input[0], [8, 10], 'input unchanged');
  assert.deepEqual(mergeIntervals([[1, 2], [2, 3]]), [[1, 3]]);
  assert.deepEqual(mergeIntervals([[1, 10], [2, 3]]), [[1, 10]]);
  assert.deepEqual(mergeIntervals([]), []);
});`,
  },
  {
    id: 'lru-cache',
    // Reference solution: proves the test can pass. Never shown to agents.
    solution: { 'lru.mjs': `export class LRUCache {\n  constructor(capacity) { this.capacity = capacity; this.map = new Map(); }\n  get(k) { if (!this.map.has(k)) return undefined; const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v; }\n  set(k, v) { this.map.delete(k); this.map.set(k, v); if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value); }\n  get size() { return this.map.size; }\n}\n` },
    prompt: 'Implement and export class LRUCache in lru.mjs: new LRUCache(capacity), get(key) returns the value or undefined and marks the key as most recently used, set(key, value) inserts or updates and marks it most recently used, evicting the least recently used key when over capacity. Also a size getter.',
    files: { 'lru.mjs': 'export class LRUCache {\n  // TODO\n}\n' },
    test: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { LRUCache } from './lru.mjs';
test('LRUCache', () => {
  const c = new LRUCache(2);
  c.set('a', 1); c.set('b', 2);
  assert.equal(c.get('a'), 1);
  c.set('c', 3);
  assert.equal(c.get('b'), undefined, 'b was least recently used');
  assert.equal(c.get('a'), 1);
  c.set('a', 10); c.set('d', 4);
  assert.equal(c.get('c'), undefined);
  assert.equal(c.get('a'), 10);
  assert.equal(c.size, 2);
});`,
  },
  {
    id: 'split-cents',
    // Reference solution: proves the test can pass. Never shown to agents.
    solution: { 'money.mjs': `export function splitCents(totalCents, n) {\n  if (!Number.isInteger(n) || n <= 0) throw new RangeError('n must be a positive integer');\n  const base = Math.floor(totalCents / n), extra = totalCents - base * n;\n  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));\n}\n` },
    prompt: 'Implement and export splitCents(totalCents, n) in money.mjs. It splits a whole number of cents into n whole-number shares that add up exactly to the total and differ by at most one cent, with the larger shares first. Throw a RangeError if n is not a positive integer.',
    files: { 'money.mjs': 'export function splitCents(totalCents, n) {\n  // TODO\n}\n' },
    test: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { splitCents } from './money.mjs';
test('splitCents', () => {
  assert.deepEqual(splitCents(100, 3), [34, 33, 33]);
  assert.deepEqual(splitCents(1001, 4), [251, 250, 250, 250]);
  assert.deepEqual(splitCents(2, 4), [1, 1, 0, 0]);
  assert.equal(splitCents(99999, 7).reduce((a, b) => a + b, 0), 99999);
  assert.throws(() => splitCents(10, 0), RangeError);
  assert.throws(() => splitCents(10, 1.5), RangeError);
});`,
  },
  {
    id: 'retry-backoff',
    // Reference solution: proves the test can pass. Never shown to agents.
    solution: { 'retry.mjs': `export async function retry(fn, { retries, baseMs, sleep }) {\n  let last;\n  for (let attempt = 0; attempt <= retries; attempt++) {\n    try { return await fn(); } catch (e) { last = e; if (attempt < retries) await sleep(baseMs * 2 ** attempt); }\n  }\n  throw last;\n}\n` },
    prompt: 'Implement and export async retry(fn, { retries, baseMs, sleep }) in retry.mjs. Call fn(); if it throws, wait baseMs * 2 ** attempt (attempt counting from 0) using the given async sleep(ms), then try again, up to `retries` retries after the first call. Return the first successful result; if every call fails, throw the last error.',
    files: { 'retry.mjs': 'export async function retry(fn, { retries, baseMs, sleep }) {\n  // TODO\n}\n' },
    test: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { retry } from './retry.mjs';
test('retry', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let calls = 0;
  const ok = await retry(async () => { calls++; if (calls < 3) throw new Error('no ' + calls); return 'yes'; }, { retries: 5, baseMs: 100, sleep });
  assert.equal(ok, 'yes');
  assert.deepEqual(waits, [100, 200]);
  waits.length = 0;
  await assert.rejects(retry(async () => { throw new Error('always'); }, { retries: 2, baseMs: 10, sleep }), /always/);
  assert.deepEqual(waits, [10, 20]);
});`,
  },
  {
    id: 'business-days',
    // Reference solution: proves the test can pass. Never shown to agents.
    solution: { 'days.mjs': `export function addBusinessDays(date, n, holidays = []) {\n  const d = new Date(\`\${date}T00:00:00Z\`), skip = new Set(holidays);\n  const iso = () => d.toISOString().slice(0, 10);\n  while (n > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6 && !skip.has(iso())) n--; }\n  return iso();\n}\n` },
    prompt: 'Implement and export addBusinessDays(date, n, holidays) in days.mjs. date is "YYYY-MM-DD"; return the date n business days later in the same format, skipping Saturdays, Sundays and any date in the holidays array (also "YYYY-MM-DD"). n is a non-negative integer; n = 0 returns the date unchanged. The result must not depend on the machine\'s time zone.',
    files: { 'days.mjs': 'export function addBusinessDays(date, n, holidays = []) {\n  // TODO\n}\n' },
    test: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { addBusinessDays } from './days.mjs';
test('addBusinessDays', () => {
  assert.equal(addBusinessDays('2026-11-20', 1), '2026-11-23', 'Friday + 1 is Monday');
  assert.equal(addBusinessDays('2026-11-25', 2, ['2026-11-26']), '2026-11-30', 'skips Thanksgiving and the weekend');
  assert.equal(addBusinessDays('2026-03-06', 5), '2026-03-13', 'across the US daylight-saving change');
  assert.equal(addBusinessDays('2026-12-31', 1, ['2027-01-01']), '2027-01-04');
  assert.equal(addBusinessDays('2026-11-21', 0), '2026-11-21');
});`,
  },
  {
    id: 'counter-race',
    // Reference solution: proves the test can pass. Never shown to agents.
    solution: { 'counter.mjs': `export class Counter {\n  constructor() { this.value = 0; this.queue = Promise.resolve(); }\n  async increment() {\n    const run = this.queue.then(async () => {\n      const v = this.value;\n      await new Promise((r) => setTimeout(r, 1));\n      this.value = v + 1;\n      return this.value;\n    });\n    this.queue = run.catch(() => {});\n    return run;\n  }\n}\n` },
    prompt: 'Counter.increment() in counter.mjs loses updates when called concurrently, so the test fails. Fix it so concurrent increments are never lost, keeping increment() async and keeping the await inside it.',
    files: { 'counter.mjs': `export class Counter {
  constructor() { this.value = 0; }
  async increment() {
    const v = this.value;
    await new Promise((r) => setTimeout(r, 1));
    this.value = v + 1;
    return this.value;
  }
}
` },
    test: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { Counter } from './counter.mjs';
test('Counter', async () => {
  const c = new Counter();
  const results = await Promise.all(Array.from({ length: 50 }, () => c.increment()));
  assert.equal(c.value, 50);
  assert.deepEqual([...results].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1), 'each call returns its own count');
});`,
  },
];
