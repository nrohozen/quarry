// QUARRY engine — pure game logic, zero DOM, fully deterministic.
// The quarry is a *set* of possible positions; the host is adversarial
// (Absurdle-style) and never commits until forced.

const LOG2 = Math.log2;

// ---------------------------------------------------------------------------
// Feedback: standard Wordle two-pass duplicate handling.
// Returns a 5-char string of 0 (gray) / 1 (yellow) / 2 (green).
// ---------------------------------------------------------------------------
export function computePattern(guess, answer) {
  const g = guess, a = answer;
  const result = [0, 0, 0, 0, 0];
  const remaining = Object.create(null);
  // pass 1: greens; count non-green answer letters
  for (let i = 0; i < 5; i++) {
    if (g[i] === a[i]) {
      result[i] = 2;
    } else {
      remaining[a[i]] = (remaining[a[i]] || 0) + 1;
    }
  }
  // pass 2: yellows, consuming remaining counts left-to-right
  for (let i = 0; i < 5; i++) {
    if (result[i] === 0 && remaining[g[i]] > 0) {
      result[i] = 1;
      remaining[g[i]]--;
    }
  }
  return result.join('');
}

function countChar(pattern, ch) {
  let n = 0;
  for (let i = 0; i < 5; i++) if (pattern[i] === ch) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Adjacency: words differing by exactly one letter at the same position.
// Wildcard bucketing: each word contributes 5 keys like "_back","a_ack",...
// ---------------------------------------------------------------------------
export function buildAdjacency(words) {
  const buckets = new Map();
  for (const w of words) {
    for (let i = 0; i < 5; i++) {
      const key = w.slice(0, i) + '_' + w.slice(i + 1);
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, arr = []);
      arr.push(w);
    }
  }
  const adj = new Map();
  for (const w of words) adj.set(w, []);
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = 0; j < arr.length; j++) {
        if (i !== j) adj.get(arr[i]).push(arr[j]);
      }
    }
  }
  // dedupe (a pair can only share one wildcard key, but be safe) + sort for determinism
  for (const [w, list] of adj) adj.set(w, [...new Set(list)].sort());
  return adj;
}

// ---------------------------------------------------------------------------
// Host bucket choice.
// buckets: Map pattern -> array of words.
// Rules: largest bucket; ties -> fewer greens, then fewer yellows, then
// lexicographically smallest pattern. "22222" may only be chosen if it is
// the ONLY bucket (that is the win).
// ---------------------------------------------------------------------------
export function chooseHostPattern(buckets) {
  const patterns = [...buckets.keys()];
  if (patterns.length === 1) return patterns[0];
  let best = null;
  for (const p of patterns) {
    if (p === '22222') continue; // never chosen while an alternative exists
    if (best === null) { best = p; continue; }
    const sizeP = buckets.get(p).length, sizeB = buckets.get(best).length;
    if (sizeP !== sizeB) { if (sizeP > sizeB) best = p; continue; }
    const gP = countChar(p, '2'), gB = countChar(best, '2');
    if (gP !== gB) { if (gP < gB) best = p; continue; }
    const yP = countChar(p, '1'), yB = countChar(best, '1');
    if (yP !== yB) { if (yP < yB) best = p; continue; }
    if (p < best) best = p;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Seeded host choice (daily hunts). seed=0/absent means the legacy fully
// deterministic host above — bit-for-bit identical behavior.
//
// With a nonzero seed the host gets per-turn wiggle room. Two independent,
// STATELESS per-turn derivations (no shared PRNG stream — replaying the same
// guesses under the same seed is identical regardless of code path):
//
//   slack_t = 0.60 + 0.35 * mulberry32(hash32(seed, turnIndex ^ SLACK_MIX))()
//             -> in [0.60, 0.95); every non-all-green bucket with
//                size >= slack_t * maxSize is a candidate
//   pick    = mulberry32(hash32(seed, turnIndex))() scaled to the candidate
//             count, over candidates sorted by pattern string
//             (canonical order -> platform-stable indexing)
//
// The all-green bucket stays excluded unless it is the only bucket.
// ADVERSARY_SLACK is retained as the historical fixed-slack documentation
// constant (v1.3); the live seeded host uses slack_t above.
// ---------------------------------------------------------------------------
export const ADVERSARY_SLACK = 0.9;

// SLACK_MIX selected by measurement (96-constant sweep over a fixed greedy
// line, slack range [0.60, 0.95)): 0x190E gave 9/10 distinct transcripts on
// Days 1-10 and 32/60 (53%) over Days 1-60 — the best observed; runners-up
// scored 30/60. NOTE: ~50% distinct per 60 days is the structural ceiling of
// this architecture against an IDENTICAL bot line (the max-bucket funnel at
// early turns caps per-game entropy at ~5 bits). Two colliding days share
// the same optimal-bot line, not the same human experience — distinct human
// guess sequences diverge immediately. Frozen at daily-board launch.
export const SLACK_MIX = 0x190E;

export function seededSlack(seed, turnIndex) {
  return 0.60 + 0.35 * mulberry32(hash32(seed, ((turnIndex >>> 0) ^ SLACK_MIX) >>> 0))();
}

// ---------------------------------------------------------------------------
// Skittish days (v1.5, movement-phase seeding). When seed != 0, each MOVE
// turn may be SKITTISH, decided statelessly per turn:
//
//   skittish_t = mulberry32(hash32(seed, turnIndex ^ SKITTISH_MIX))() < P_SKITTISH
//
// On a skittish turn the quarry MUST flee: S := ∪ unscorchedNeighbors(p),
// except a trapped p (zero unscorched neighbors) contributes {p} — trapped
// prey may hold, preserving the S-nonempty invariant. This is exactly the
// mayStay=false branch of applyMove. Non-skittish move turns keep the
// may-stay union. seed=0 turns are never skittish (legacy bit-identical).
// ---------------------------------------------------------------------------
// SKITTISH_MIX/P selected by measurement (64-constant sweep at P=0.5, plus a
// P∈{0.4,0.6} sweep over the top 16): 0x7B15 @ P=0.5 gave 50/60 (83%)
// distinct Days 1-60 and 10/10 on Days 1-10 — the best observed (several
// combos tie at 50/60; the 90% target is above this architecture's ceiling).
// Skittish movement lifted the fixed-line diversity record from 32/60 to
// 50/60. WHOLE DAILY-HOST DERIVATION FROZEN AT BOARD LAUNCH 2026-07-21.
export const SKITTISH_MIX = 0x7B15;
export const P_SKITTISH = 0.5;

export function isSkittish(seed, turnIndex) {
  return mulberry32(hash32(seed, ((turnIndex >>> 0) ^ SKITTISH_MIX) >>> 0))() < P_SKITTISH;
}

// xmur3-style integer mix of two uint32s -> uint32. All ops are 32-bit
// integer ops, so results are identical on every JS engine.
export function hash32(a, b) {
  let h = Math.imul(a >>> 0, 0x9E3779B1) >>> 0;
  h = (h + ((b >>> 0) + 0x9E3779B9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function chooseHostPatternSeeded(buckets, seed, turnIndex) {
  const patterns = [...buckets.keys()];
  if (patterns.length === 1) return patterns[0];
  const eligible = patterns.filter(p => p !== '22222');
  let maxSize = 0;
  for (const p of eligible) {
    const s = buckets.get(p).length;
    if (s > maxSize) maxSize = s;
  }
  const slack = seededSlack(seed, turnIndex);
  const cands = eligible
    .filter(p => buckets.get(p).length >= slack * maxSize)
    .sort(); // canonical order before indexing
  const r = mulberry32(hash32(seed, turnIndex))();
  return cands[Math.min(cands.length - 1, Math.floor(r * cands.length))];
}

export function bucketize(candidates, guess) {
  const buckets = new Map();
  for (const p of candidates) {
    const pat = computePattern(guess, p);
    let arr = buckets.get(pat);
    if (!arr) buckets.set(pat, arr = []);
    arr.push(p);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Movement phase: S := union over p in S of ({p} ∪ neighbors(p)) minus scorched.
// Returns { set, parents } where parents maps each new position q to one
// parent p (preferring q's own previous self if q was already in S).
// Invariant: S never contains scorched words, so with mayStay=true the
// result can never be empty. With mayStay=false, a position with no legal
// neighbor is forced to stay (quarry trapped in place).
// ---------------------------------------------------------------------------
export function applyMove(S, adjacency, scorched, mayStay) {
  const next = new Set();
  const parents = new Map();
  if (mayStay) {
    for (const p of S) { next.add(p); parents.set(p, p); } // self first => self-preference
    for (const p of S) {
      for (const n of adjacency.get(p) || []) {
        if (!scorched.has(n) && !parents.has(n)) { next.add(n); parents.set(n, p); }
      }
    }
  } else {
    for (const p of S) {
      let movedSomewhere = false;
      for (const n of adjacency.get(p) || []) {
        if (!scorched.has(n)) {
          movedSomewhere = true;
          if (!parents.has(n)) { next.add(n); parents.set(n, p); }
        }
      }
      if (!movedSomewhere && !next.has(p)) { next.add(p); parents.set(p, p); } // forced stay
    }
  }
  return { set: next, parents };
}

// ---------------------------------------------------------------------------
// Live keyboard intel, computed from the CURRENT surviving-hides set
// (post-movement). For each letter a-z:
//   'impossible' — the letter appears in zero hides
//   'locked'     — some position p exists where EVERY hide has it at p
//   'present'    — the letter appears in every hide, but no position is fixed
//   'unknown'    — anything else (in some hides but not all)
// locked outranks present. Empty input (cannot happen in a live game — the
// S-nonempty invariant) yields all-'unknown': no hides, no information.
// ---------------------------------------------------------------------------
export function letterIntel(possibleWords) {
  const words = Array.isArray(possibleWords) ? possibleWords : [...possibleWords];
  const AZ = 'abcdefghijklmnopqrstuvwxyz';
  const intel = {};
  if (words.length === 0) {
    for (const ch of AZ) intel[ch] = 'unknown';
    return intel;
  }
  const inCount = {};   // words containing the letter at least once
  const posCount = {};  // words with the letter at position i
  for (const ch of AZ) { inCount[ch] = 0; posCount[ch] = [0, 0, 0, 0, 0]; }
  for (const w of words) {
    let seenMask = 0;
    for (let i = 0; i < 5; i++) {
      const ch = w[i];
      posCount[ch][i]++;
      const bit = 1 << (w.charCodeAt(i) - 97);
      if (!(seenMask & bit)) { seenMask |= bit; inCount[ch]++; }
    }
  }
  const n = words.length;
  for (const ch of AZ) {
    if (inCount[ch] === 0) intel[ch] = 'impossible';
    else if (posCount[ch].indexOf(n) !== -1) intel[ch] = 'locked';
    else if (inCount[ch] === n) intel[ch] = 'present';
    else intel[ch] = 'unknown';
  }
  return intel;
}

// Companion for UI copy: the pinned position (0-based) of a 'locked' letter,
// or -1 if none.
export function lockedPosition(possibleWords, letter) {
  const words = Array.isArray(possibleWords) ? possibleWords : [...possibleWords];
  if (words.length === 0) return -1;
  for (let i = 0; i < 5; i++) {
    let all = true;
    for (const w of words) if (w[i] !== letter) { all = false; break; }
    if (all) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Dead-end prey: a word with zero unscorched neighbors. If the quarry is
// standing there, it can never leave — a prime target.
// ---------------------------------------------------------------------------
export function isCornered(word, adjacency, scorched) {
  for (const n of adjacency.get(word) || []) {
    if (!scorched.has(n)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Game factory.
// options: {
//   answers:  array of 5-letter words = graph nodes / possible quarry positions
//   allowed:  extra allowed guesses (optional; guesses = answers ∪ allowed)
//   quarryMayStay: bool (default true)
//   moveEveryNTurns: int (default 1)
//   seed: uint32 (default 0 = legacy deterministic host, bit-for-bit)
// }
// ---------------------------------------------------------------------------
export function newGame(options) {
  const answers = options.answers.slice();
  const answerSet = new Set(answers);
  const allowedSet = new Set(answers);
  for (const w of options.allowed || []) allowedSet.add(w);
  const config = {
    quarryMayStay: options.quarryMayStay !== false,
    moveEveryNTurns: options.moveEveryNTurns || 1,
    seed: (options.seed || 0) >>> 0,
  };
  const adjacency = options.adjacency || buildAdjacency(answers);

  let S = new Set(answers);
  const scorched = new Set();
  let turn = 0;
  let gameOver = false;
  let finalWord = null;
  const history = [];          // turn reports
  const moveParents = [];      // moveParents[turn] = Map q->p (only for turns that moved)
  let totalBitsGained = 0;
  let totalBitsLeaked = 0;

  function validate(word) {
    if (gameOver) return 'game-over';
    if (typeof word !== 'string' || !/^[a-z]{5}$/.test(word)) return 'bad-word';
    if (!allowedSet.has(word)) return 'not-a-word';
    if (scorched.has(word)) return 'already-scorched';
    return null;
  }

  function guess(wordRaw) {
    const word = String(wordRaw).toLowerCase();
    const err = validate(word);
    if (err) return { error: err };

    turn += 1;
    const sizeBefore = S.size;

    // 1-2. bucket + host choice (turnIndex = guesses made before this one)
    const buckets = bucketize(S, word);
    const pattern = config.seed
      ? chooseHostPatternSeeded(buckets, config.seed, turn - 1)
      : chooseHostPattern(buckets);
    const win = pattern === '22222';

    // 3. collapse S to the chosen bucket
    S = new Set(buckets.get(pattern));
    const sizeAfterFilter = S.size;

    // 4. scorch the guess if it is a graph node
    const scorchedGuess = answerSet.has(word);
    if (scorchedGuess) scorched.add(word);

    // 5. movement phase. Seeded games may be SKITTISH on a move turn: the
    // quarry must flee (mayStay=false path; trapped prey still holds).
    let moved = false;
    let skittish = false;
    let sizeAfterMove = sizeAfterFilter;
    if (win) {
      gameOver = true;
      finalWord = word;
    } else if (turn % config.moveEveryNTurns === 0) {
      skittish = config.seed !== 0 && isSkittish(config.seed, turn - 1);
      const { set, parents } = applyMove(
        S, adjacency, scorched, skittish ? false : config.quarryMayStay);
      S = set;
      moveParents[turn] = parents;
      moved = true;
      sizeAfterMove = S.size;
    }

    const bitsGained = LOG2(sizeBefore / sizeAfterFilter);
    const bitsLeaked = moved ? LOG2(sizeAfterMove / sizeAfterFilter) : 0;
    totalBitsGained += bitsGained;
    totalBitsLeaked += bitsLeaked;

    const report = {
      turn, guess: word, pattern, win, moved, skittish, scorchedGuess,
      sizeBefore, sizeAfterFilter, sizeAfterMove,
      bitsGained, bitsLeaked,
    };
    history.push(report);
    return report;
  }

  // Walk parent maps backward from the final position: the one fully
  // consistent escape trajectory the host confesses to. Oldest first;
  // consecutive stays collapsed.
  function escapeRoute() {
    if (!gameOver || finalWord === null) return null;
    let cur = finalWord;
    const route = [cur];
    for (let t = turn - 1; t >= 1; t--) {
      const pm = moveParents[t];
      if (!pm) continue;
      const parent = pm.get(cur);
      if (parent === undefined) return route; // should not happen (invariant)
      if (parent !== cur) route.unshift(parent);
      cur = parent;
    }
    return route;
  }

  return {
    guess,
    escapeRoute,
    get turn() { return turn; },
    get size() { return S.size; },
    get gameOver() { return gameOver; },
    get finalWord() { return finalWord; },
    get history() { return history.slice(); },
    get scorchedList() { return [...scorched]; },
    get totalBitsGained() { return totalBitsGained; },
    get totalBitsLeaked() { return totalBitsLeaked; },
    get config() { return { ...config, totalAnswers: answers.length }; },
    candidates() { return [...S]; },        // for sim/debug
    scorchedSet() { return scorched; },     // for sim (read-only use)
    adjacencyMap() { return adjacency; },   // for sim
    isAnswer(w) { return answerSet.has(w); },
    isAllowed(w) { return allowedSet.has(w); },
  };
}

// ---------------------------------------------------------------------------
// Pure replay: feed a guess list through a fresh game. This is how the
// server verifies scores — the replay IS the proof. Trailing guesses after
// a win are ignored.
// modeConfig: { moveEveryNTurns, quarryMayStay }
// wordlists:  { answers, allowed, adjacency? }
// ---------------------------------------------------------------------------
export function replayGame(seed, modeConfig, guesses, wordlists) {
  const game = newGame({
    answers: wordlists.answers,
    allowed: wordlists.allowed,
    adjacency: wordlists.adjacency,
    quarryMayStay: modeConfig.quarryMayStay !== false,
    moveEveryNTurns: modeConfig.moveEveryNTurns || 1,
    seed: seed,
  });
  const transcript = [];
  for (const g of guesses) {
    if (game.gameOver) break;
    const rep = game.guess(String(g).toLowerCase());
    if (rep.error) {
      return { won: false, moves: game.turn, transcript, error: rep.error, badGuess: g };
    }
    transcript.push(rep);
    if (rep.win) return { won: true, moves: game.turn, transcript };
  }
  return { won: false, moves: game.turn, transcript };
}

// ---------------------------------------------------------------------------
// Daily hunt derivation. Day 1 = 2026-07-21 UTC; resets at midnight UTC.
// Daily rules = FOX (moveEvery 1) + the daily seed.
// ---------------------------------------------------------------------------
export const DAILY_EPOCH_DAY = Math.floor(Date.UTC(2026, 6, 21) / 86400000) - 1;

export function dailyDayNumber(ms) {
  return Math.floor((ms === undefined ? Date.now() : ms) / 86400000) - DAILY_EPOCH_DAY;
}

// || 1 guards the (1-in-4-billion) hash landing on 0, which would mean
// "legacy deterministic host" — a daily must always be seeded.
export function dailySeed(dayNumber) {
  return hash32(dayNumber >>> 0, 0x51A44) || 1;
}

export const DAILY_MODE = Object.freeze({
  moveEveryNTurns: 1,
  quarryMayStay: true,
  trackerThreshold: 25, // UI hint; not used by the engine itself
});
