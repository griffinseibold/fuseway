#!/usr/bin/env node
// Packages this folder as a VSIX (a zip with two manifest files) without vsce or other dependencies.
//   node extension/build.mjs [out.vsix]     default: extension/loadout.vsix
import { crc32 } from 'node:zlib';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'));
const out = process.argv[2] || join(DIR, `${pkg.name}.vsix`);
const REPO = join(DIR, '..');
const SHIP = ['package.json', 'extension.js', 'router.js', 'rules.json', 'learner.js', 'route-cases.json', 'README.md'];
// The loadout CLI and everything `loadout init` installs, at the same paths as in the repo, so the bundled CLI
// finds them next to itself.
const BUNDLE = ['bin/loadout.mjs', 'template', '.agents/fusion/server.mjs', '.agents/fusion/smoke.mjs',
  '.agents/tasks/refresh-context.md', '.agents/skills', 'local-llm/models.json', 'local-llm/bench.sh'];
const walk = (rel) => (statSync(join(REPO, rel)).isDirectory()
  ? readdirSync(join(REPO, rel)).flatMap((f) => walk(join(rel, f))) : [rel.split(sep).join('/')]);

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" /></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
`;
const payload = [
  ...SHIP.filter((f) => { try { return statSync(join(DIR, f)).isFile(); } catch { return false; } })
    .map((f) => [`extension/${f}`, readFileSync(join(DIR, f))]),
  ...BUNDLE.flatMap(walk).map((f) => [`extension/${f}`, readFileSync(join(REPO, f))])];
// Every file extension in the package needs a content type; the exact type doesn't matter to VS Code.
const exts = [...new Set(['vsixmanifest', ...payload.map(([n]) => n.split('/').pop()).filter((b) => b.includes('.')).map((b) => b.split('.').pop())])];
const types = `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${exts
  .map((e) => `<Default Extension=".${e}" ContentType="${{ json: 'application/json', js: 'application/javascript', mjs: 'application/javascript', md: 'text/markdown', vsixmanifest: 'text/xml' }[e] || 'application/octet-stream'}" />`).join('')}</Types>\n`;
const files = [['[Content_Types].xml', Buffer.from(types)], ['extension.vsixmanifest', Buffer.from(manifest)], ...payload];

// A stored (uncompressed) zip: local headers, then the central directory, then its end record.
const locals = [], centrals = [];
let offset = 0;
for (const [name, data] of files) {
  const n = Buffer.from(name), crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
  locals.push(local, n, data); centrals.push(central, n);
  offset += 30 + n.length + data.length;
}
const dir = Buffer.concat(centrals);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
writeFileSync(out, Buffer.concat([...locals, dir, end]));
console.log(`${relative(process.cwd(), out)}: ${files.length - 2} files`);
