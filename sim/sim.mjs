// QUARRY headless playtest harness.
// Usage: node sim/sim.mjs [--bot greedy|random] [--games 20] [--maxMoves 60] [--seed 1] [--shuffleStart] [--moveEvery 1]
// --shuffleStart: greedy bot opens each game with a random answer word (the
// engine and greedy policy are deterministic, so without it every greedy
// game is identical).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newGame, buildAdjacency, bucketize, chooseHostPattern, applyMove } from '../src/engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const readWords = f => readFileSync(join(here, '..', 'words', f), 'utf8')
  .split(/\r?\n/).map(w => w.trim()).filter(w => /^[a-z]{5}$/.test(w));

const ANSWERS = readWords('answers.txt');
const GUESSES = readWords('guesses.txt');
const ADJ = buildAdjacency(ANSWERS);

// --- CLI args ---
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const BOT = opt('bot', 'greedy');
const GAMES = parseInt(opt('games', '20'), 10);
const MAX_MOVES = parseInt(opt('maxMoves', '60'), 10);
const SEED = parseInt(opt('seed', '1'), 10);
const SHUFFLE_START = args.includes('--shuffleStart');
const MOVE_EVERY = parseInt(opt('moveEvery', '1'), 10); // 2 = FAWN, 1 = FOX/WOLF
const GAME_SEED = parseInt(opt('gameSeed', '0'), 10) >>> 0; // nonzero = seeded daily-style host

// --- seeded LCG (numerical recipes constants) ---
function makeLCG(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- bots ---
function randomBot(rng) {
  return (game) => {
    // pick a random un-scorched answers-list word
    const scor = game.scorchedSet();
    let w;
    do { w = ANSWERS[Math.floor(rng() * ANSWERS.length)]; } while (scor.has(w));
    return w;
  };
}

function greedyBot(rng) {
  return (game) => {
    if (SHUFFLE_START && game.turn === 0) {
      let w;
      do { w = ANSWERS[Math.floor(rng() * ANSWERS.length)]; } while (game.scorchedSet().has(w));
      return w;
    }
    const S = game.candidates();
    const scor = game.scorchedSet();
    // candidate guesses: all of S, capped at 400 by taking every k-th element
    let cands = S;
    if (cands.length > 400) {
      const k = Math.ceil(cands.length / 400);
      cands = cands.filter((_, i) => i % k === 0);
    }
    let best = null, bestScore = Infinity;
    const sSet = new Set(S);
    for (const g of cands) {
      const buckets = bucketize(S, g);
      const pattern = chooseHostPattern(buckets);
      let score;
      if (pattern === '22222') {
        score = 0; // immediate catch
      } else if ((game.turn + 1) % MOVE_EVERY !== 0) {
        score = buckets.get(pattern).length; // no movement phase on this turn
      } else {
        const newS = new Set(buckets.get(pattern));
        const scor2 = new Set(scor);
        if (game.isAnswer(g)) scor2.add(g);
        score = applyMove(newS, ADJ, scor2, true).set.size;
      }
      // minimize sizeAfterMove; ties -> in-S first (all are), then lexicographic
      if (score < bestScore ||
          (score === bestScore && sSet.has(g) && !sSet.has(best)) ||
          (score === bestScore && sSet.has(g) === sSet.has(best) && g < best)) {
        best = g; bestScore = score;
      }
    }
    return best;
  };
}

// --- run ---
const rng = makeLCG(SEED);
const results = [];
const trajSums = new Array(15).fill(0);
const trajCounts = new Array(15).fill(0);

for (let gi = 0; gi < GAMES; gi++) {
  const game = newGame({ answers: ANSWERS, allowed: GUESSES, adjacency: ADJ, moveEveryNTurns: MOVE_EVERY, seed: GAME_SEED });
  const pick = BOT === 'random' ? randomBot(rng) : greedyBot(rng);
  let moves = 0;
  while (!game.gameOver && moves < MAX_MOVES) {
    const w = pick(game);
    const rep = game.guess(w);
    if (rep.error) throw new Error(`bot produced invalid guess "${w}": ${rep.error}`);
    moves++;
    if (moves <= 15) { trajSums[moves - 1] += rep.sizeAfterMove; trajCounts[moves - 1]++; }
  }
  const caught = game.gameOver;
  results.push({ moves, caught });
  const route = caught ? game.escapeRoute() : null;
  console.log(
    `game ${String(gi + 1).padStart(2)}: ${caught ? 'CAUGHT' : 'escaped'} in ${moves} moves` +
    (caught ? ` — final "${game.finalWord}", route [${route.join(' → ')}]` : '')
  );
  if (caught) {
    // sanity: route must end at finalWord and each hop must be a graph edge
    if (route[route.length - 1] !== game.finalWord) throw new Error('route does not end at final word');
    for (let i = 1; i < route.length; i++) {
      if (!ADJ.get(route[i - 1]).includes(route[i])) throw new Error(`route hop ${route[i-1]}→${route[i]} is not an edge`);
    }
  }
}

const caughtGames = results.filter(r => r.caught).map(r => r.moves).sort((a, b) => a - b);
const n = caughtGames.length;
console.log(`\nbot=${BOT} games=${GAMES} maxMoves=${MAX_MOVES} seed=${SEED} moveEvery=${MOVE_EVERY} gameSeed=${GAME_SEED}`);
console.log(`catch rate: ${n}/${GAMES} (${(100 * n / GAMES).toFixed(0)}%)`);
if (n) {
  const median = n % 2 ? caughtGames[(n - 1) / 2] : (caughtGames[n / 2 - 1] + caughtGames[n / 2]) / 2;
  const mean = caughtGames.reduce((a, b) => a + b, 0) / n;
  console.log(`moves (caught games): min=${caughtGames[0]} median=${median} mean=${mean.toFixed(1)} max=${caughtGames[n - 1]}`);
}
console.log('avg |S| after each of the first 15 turns:');
console.log('  ' + trajSums.map((s, i) => trajCounts[i] ? (s / trajCounts[i]).toFixed(0) : '-').join(' '));
