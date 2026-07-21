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

    // 1-2. bucket + host choice
    const buckets = bucketize(S, word);
    const pattern = chooseHostPattern(buckets);
    const win = pattern === '22222';

    // 3. collapse S to the chosen bucket
    S = new Set(buckets.get(pattern));
    const sizeAfterFilter = S.size;

    // 4. scorch the guess if it is a graph node
    const scorchedGuess = answerSet.has(word);
    if (scorchedGuess) scorched.add(word);

    // 5. movement phase
    let moved = false;
    let sizeAfterMove = sizeAfterFilter;
    if (win) {
      gameOver = true;
      finalWord = word;
    } else if (turn % config.moveEveryNTurns === 0) {
      const { set, parents } = applyMove(S, adjacency, scorched, config.quarryMayStay);
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
      turn, guess: word, pattern, win, moved, scorchedGuess,
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
