// QUARRY server bundler — same inliner pattern as build.mjs.
// Emits dist/server.mjs: engine + word lists + server core in one file,
// zero npm deps, runs with plain `node dist/server.mjs`.
// Usage: node server/build-server.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const words = f => read(join('words', f))
  .split(/\r?\n/).map(w => w.trim()).filter(w => /^[a-z]{5}$/.test(w));

const answers = words('answers.txt');
const guesses = words('guesses.txt');
console.log(`words: ${answers.length} answers, ${guesses.length} extra guesses`);

const wordsJs =
  `const ANSWERS_RAW="${answers.join(',')}";\n` +
  `const GUESSES_RAW="${guesses.join(',')}";`;

// engine: strip ESM export keywords -> plain top-level declarations
const engineJs = read('src/engine.mjs')
  .replace(/^export\s+(function|const|let|var|class)/gm, '$1')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

// server core: drop the dev header (engine import + word-file loading)
const serverSrc = read('server/server.mjs');
const HDR_START = '/* __DEV_HEADER_START__';
const HDR_END = '__DEV_HEADER_END__ */';
const hs = serverSrc.indexOf(HDR_START);
const he = serverSrc.indexOf(HDR_END);
if (hs < 0 || he < 0) throw new Error('dev header markers missing in server/server.mjs');
const serverCore = serverSrc.slice(0, hs) + serverSrc.slice(he + HDR_END.length);

const out = [
  '// QUARRY server — self-contained bundle (engine + word lists inlined).',
  '// Built by server/build-server.mjs. Run: node dist/server.mjs',
  '// Env: PORT (default 3000), DB_PATH (default ./data/quarry.db)',
  wordsJs,
  '// ---------------- engine (src/engine.mjs) ----------------',
  engineJs,
  '// ---------------- server core (server/server.mjs) ----------------',
  serverCore,
].join('\n');

// the only imports left must be node: builtins
const badImport = out.match(/^\s*import\s.*from\s+['"](?!node:)/m);
if (badImport) throw new Error('non-builtin import leaked into bundle: ' + badImport[0]);

mkdirSync(join(root, 'dist'), { recursive: true });
const outPath = join(root, 'dist', 'server.mjs');
writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${(out.length / 1024).toFixed(1)} KiB)`);
