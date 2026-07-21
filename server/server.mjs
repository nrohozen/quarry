// QUARRY daily-hunt server. Zero npm dependencies: node:http + node:sqlite.
// Dev entry:  node server/server.mjs        (reads ../src/engine.mjs + ../words)
// Bundled:    node dist/server.mjs          (engine + word lists inlined)
// Env: PORT (default 3000), DB_PATH (default ./data/quarry.db)
//
// Scores are proofs: a submission is a guess list, and the server replays it
// through the same engine with the day's seed. The replay result is the score.

/* __DEV_HEADER_START__ (removed by server/build-server.mjs) */
import {
  buildAdjacency, replayGame, dailyDayNumber, dailySeed, DAILY_MODE,
} from '../src/engine.mjs';
import { readFileSync as __devRead } from 'node:fs';
import { dirname as __devDirname, join as __devJoin } from 'node:path';
import { fileURLToPath as __devFileURL } from 'node:url';
const __devDir = __devDirname(__devFileURL(import.meta.url));
const __devWords = f => __devRead(__devJoin(__devDir, '..', 'words', f), 'utf8')
  .split(/\r?\n/).map(w => w.trim()).filter(w => /^[a-z]{5}$/.test(w)).join(',');
const ANSWERS_RAW = __devWords('answers.txt');
const GUESSES_RAW = __devWords('guesses.txt');
/* __DEV_HEADER_END__ */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname as pathDirname } from 'node:path';

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || './data/quarry.db';

const ANSWERS = ANSWERS_RAW.split(',');
const GUESSES = GUESSES_RAW.split(',');
const ADJACENCY = buildAdjacency(ANSWERS);
const ALLOWED = new Set(ANSWERS);
for (const w of GUESSES) ALLOWED.add(w);
const WORDLISTS = { answers: ANSWERS, allowed: GUESSES, adjacency: ADJACENCY };

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------
mkdirSync(pathDirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec(`CREATE TABLE IF NOT EXISTS scores (
  name  TEXT    NOT NULL,
  day   INTEGER NOT NULL,
  moves INTEGER NOT NULL,
  ts    INTEGER NOT NULL,
  PRIMARY KEY (name, day)
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_scores_day_moves ON scores(day, moves);');

const stmtUpsert = db.prepare(`INSERT INTO scores (name, day, moves, ts) VALUES (?, ?, ?, ?)
  ON CONFLICT(name, day) DO UPDATE SET moves = excluded.moves, ts = excluded.ts
  WHERE excluded.moves < scores.moves;`);
const stmtGet = db.prepare('SELECT name, moves, ts FROM scores WHERE name = ? AND day = ?;');
const stmtBoard = db.prepare('SELECT name, moves, ts FROM scores WHERE day = ? ORDER BY moves ASC, ts ASC LIMIT ?;');
const stmtRank = db.prepare(`SELECT COUNT(*) AS n FROM scores
  WHERE day = ? AND (moves < ? OR (moves = ? AND ts < ?));`);
const stmtPlayers = db.prepare('SELECT COUNT(*) AS n FROM scores WHERE day = ?;');

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
const PROFANITY = ['fuck', 'shit', 'cunt', 'nigg', 'fagg', 'kike', 'whore'];

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  let n = raw.replace(/\s+/g, ' ').trim().replace(/[^a-zA-Z0-9 _.-]/g, '');
  n = n.replace(/\s+/g, ' ').trim();
  if (n.length < 1 || n.length > 12) return null;
  const low = n.toLowerCase();
  for (const bad of PROFANITY) if (low.includes(bad)) return null;
  return n;
}

// ---------------------------------------------------------------------------
// rate limiting (in-memory; trust X-Forwarded-For first hop only)
// ---------------------------------------------------------------------------
const RATE = { POST: { limit: 10, windowMs: 60000 }, GET: { limit: 60, windowMs: 60000 } };
const hits = new Map(); // ip -> { POST: [ts...], GET: [ts...] }

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip, method) {
  const cfg = RATE[method];
  if (!cfg) return false;
  const now = Date.now();
  let rec = hits.get(ip);
  if (!rec) { rec = { POST: [], GET: [] }; hits.set(ip, rec); }
  rec[method] = rec[method].filter(t => now - t < cfg.windowMs);
  if (rec[method].length >= cfg.limit) return true;
  rec[method].push(now);
  if (hits.size > 10000) hits.clear(); // crude memory cap; fine for this scale
  return false;
}

// ---------------------------------------------------------------------------
// http plumbing
// ---------------------------------------------------------------------------
const MAX_BODY = 4096;
const MAX_GUESSES = 400;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req, res, cb) {
  let size = 0;
  const chunks = [];
  let done = false;
  req.on('data', c => {
    if (done) return;
    size += c.length;
    if (size > MAX_BODY) {
      done = true;
      send(res, 413, { error: 'too-large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!done) cb(Buffer.concat(chunks).toString('utf8')); });
  req.on('error', () => { if (!done) { done = true; try { send(res, 400, { error: 'bad-request' }); } catch (e) {} } });
}

function boardRows(day, limit) {
  return stmtBoard.all(day, limit).map(r => ({ name: r.name, moves: Number(r.moves), ts: Number(r.ts) }));
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------
function handleScore(res, raw) {
  let body;
  try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'bad-json' }); }
  if (typeof body !== 'object' || body === null) return send(res, 400, { error: 'bad-json' });

  const name = sanitizeName(body.name);
  if (!name) return send(res, 400, { error: 'bad-name' });

  const today = dailyDayNumber();
  if (!Number.isInteger(body.day) || body.day !== today) {
    return send(res, 409, { error: 'wrong-day', today });
  }

  const guesses = body.guesses;
  if (!Array.isArray(guesses) || guesses.length < 1 || guesses.length > MAX_GUESSES) {
    return send(res, 400, { error: 'bad-guesses' });
  }
  for (const g of guesses) {
    if (typeof g !== 'string' || !ALLOWED.has(g.toLowerCase())) {
      return send(res, 400, { error: 'bad-guess', word: String(g).slice(0, 16) });
    }
  }

  // the replay IS the score
  const result = replayGame(dailySeed(today), DAILY_MODE, guesses, WORDLISTS);
  if (!result.won) return send(res, 422, { error: 'not-a-win' });

  const ts = Date.now();
  stmtUpsert.run(name, today, result.moves, ts);
  const row = stmtGet.get(name, today); // best kept row (upsert may have kept the older/better one)
  const moves = Number(row.moves), rowTs = Number(row.ts);
  const rank = Number(stmtRank.get(today, moves, moves, rowTs).n) + 1;
  return send(res, 200, { ok: true, name, moves, rank, board: boardRows(today, 10) });
}

function handleBoard(res, query) {
  const today = dailyDayNumber();
  let day = today;
  if (query.has('day')) {
    day = Number(query.get('day'));
    if (!Number.isInteger(day) || day < 1) return send(res, 400, { error: 'bad-day' });
    if (day > today) return send(res, 400, { error: 'future-day', today });
  }
  return send(res, 200, {
    day,
    board: boardRows(day, 20),
    players: Number(stmtPlayers.get(day).n),
  });
}

function handleHealth(res) {
  const today = dailyDayNumber();
  return send(res, 200, { ok: true, day: today, players_today: Number(stmtPlayers.get(today).n) });
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }

    const ip = clientIp(req);
    if ((req.method === 'POST' || req.method === 'GET') && rateLimited(ip, req.method)) {
      return send(res, 429, { error: 'rate-limited' });
    }

    if (req.method === 'POST' && path === '/api/score') {
      return readBody(req, res, raw => {
        try { handleScore(res, raw); }
        catch (e) { try { send(res, 500, { error: 'internal' }); } catch (e2) {} }
      });
    }
    if (req.method === 'GET' && path === '/api/board') return handleBoard(res, url.searchParams);
    if (req.method === 'GET' && path === '/api/health') return handleHealth(res);
    return send(res, 404, { error: 'not-found' });
  } catch (e) {
    try { send(res, 500, { error: 'internal' }); } catch (e2) {}
  }
});

server.listen(PORT, () => {
  console.log(`QUARRY server on :${PORT} — day ${dailyDayNumber()}, db ${DB_PATH}`);
});
