// QUARRY build — inlines words + engine + ui + style into a single
// self-contained dist/index.html (no imports, no external requests).
// Usage: node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(join(root, p), 'utf8');

const words = f => read(join('words', f))
  .split(/\r?\n/).map(w => w.trim()).filter(w => /^[a-z]{5}$/.test(w));

const answers = words('answers.txt');
const guesses = words('guesses.txt');
console.log(`words: ${answers.length} answers, ${guesses.length} extra guesses`);

const wordsJs =
  `const ANSWERS_RAW="${answers.join(',')}";\n` +
  `const GUESSES_RAW="${guesses.join(',')}";`;

// strip ESM export keywords so the engine runs as a plain inline script
const engineJs = read('src/engine.mjs')
  .replace(/^export\s+(function|const|let|var|class)/gm, '$1')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

const uiJs = read('src/ui.js');
const styleCss = read('src/style.css');

let html = read('src/template.html')
  .replace('/*__STYLE__*/', () => styleCss)
  .replace('/*__WORDS__*/', () => wordsJs)
  .replace('/*__ENGINE__*/', () => engineJs)
  .replace('/*__UI__*/', () => uiJs);

if (/\/\*__[A-Z]+__\*\//.test(html)) throw new Error('unreplaced template token');
if (/^\s*(import|export)\s/m.test(html)) throw new Error('module syntax leaked into dist');

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'index.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(1)} KiB)`);
