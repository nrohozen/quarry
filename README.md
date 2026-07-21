# QUARRY

*Wordle, but the word runs.*

QUARRY is a Wordle variant where the answer is a moving target. After each guess
it may flee one step along the word-ladder graph — words differing by exactly one
letter at the same position (SHARE → SHORE → STORE). Colors are judged against
where the quarry stood **at the moment you guessed**, so old clues rot.

Every word you guess becomes **scorched earth**: the quarry may never stand on it
or move through it again. You win by cutting the graph and cornering it.

The host is adversarial (Absurdle-style): it never commits to a single answer.
It maintains *every* position consistent with the feedback it has given, always
answering to keep your uncertainty maximal, and only concedes when you leave it
exactly one hide. On a win it confesses one fully consistent escape trajectory —
the replay you see on the victory screen.

Unlimited guesses. Your score is how few it takes.

**There is no secret word to solve.** You win by cornering a moving target:
burn words to wall off its escape routes, then strike.

## Difficulty modes (v1.1)

| mode | flees | tracker |
|------|-------|---------|
| 🐇 FAWN | every 2nd turn | shows the actual hides at ≤50 |
| 🦊 FOX (default) | every turn | shows the actual hides at ≤25 |
| 🐺 WOLF | every turn | none — you hunt blind |

The **tracker** ("fresh tracks" in the 🔍 hunt panel) lists every word the quarry
could still be once the trail is warm enough. Chips are clickable (prefill the
guess row); chips with zero unscorched neighbors are marked as **cornered** —
dead-end prey. Changing mode mid-game asks for confirmation and starts a new
hunt; the selection persists in `localStorage`.

Also in v1.1: **🏳 abandon hunt** (surrender — reveals the surviving hides and
records an escape), a **🏆 local leaderboard** per difficulty
(`localStorage["quarry_stats_v1"]`: best / average / caught-vs-escaped + last 15
games; only finished games count — refreshing or starting a new game records
nothing), and hover tooltips on every piece of hunt jargon. Each difficulty's
hunt is fully deterministic, so a perfect line exists — your best IS the record.

## Rules in five lines

1. Guess 5-letter words; feedback is standard Wordle green/yellow/gray.
2. Feedback reflects the quarry's position when you guessed — then it may move
   one ladder-step (or stay put).
3. Guessed words (from the answer list) are scorched: permanent walls in the graph.
4. The host is a lawyer, not a liar: every color it shows stays consistent with
   some surviving hide.
5. Corner it — herd it into a dead end with your own scorched words.

## Build

```
node build.mjs
```

Writes `dist/index.html` — a single self-contained file (word lists, engine, UI,
and styles all inlined; no network requests, works offline, ~130 KiB). Open it in
any browser:

```
start dist/index.html      # Windows
```

## Simulation harness

```
node sim/sim.mjs [--bot greedy|random] [--games 20] [--maxMoves 60] [--seed 1] [--shuffleStart] [--moveEvery 1]
```

- `random` — seeded-LCG bot guessing random un-scorched answer words.
- `greedy` — one-ply lookahead: picks the guess minimizing the host's surviving
  set size after its adversarial reply and the movement phase (candidates capped
  at 400).
- `--shuffleStart` — greedy opens each game with a random word; without it the
  engine and policy are fully deterministic, so every greedy game is identical.
- `--moveEvery 2` — FAWN-mode movement cadence (quarry flees every 2nd turn).
  Reference run (greedy, 8 games, `--shuffleStart`): FAWN median 6 moves vs
  FOX median 9 — the slower quarry is measurably easier.

Prints per-game move counts, catch rate, min/median/mean/max moves, and the
average `|S|` trajectory over the first 15 turns.

## Project layout

```
words/answers.txt    2315 possible quarry positions (graph nodes)
words/guesses.txt    10657 extra allowed guesses (feedback only, never scorched)
src/engine.mjs       pure game logic (ESM, zero DOM, deterministic)
src/ui.js            DOM / rendering / input
src/style.css        night-hunt theme
src/template.html    page skeleton with build tokens
build.mjs            inliner -> dist/index.html
sim/sim.mjs          headless playtest bots
```

## Origin

The core mechanic — the answer *moves* one step along the word-ladder graph
between guesses, feedback is judged against its position at guess time, and
every guessed word becomes scorched earth the quarry can never enter, so the
player wins by cutting the graph and cornering it under an adversarial
set-tracking host — was designed and first published here in July 2026. A
survey of existing variants at the time (Absurdle, Weaver, xordle, Fibble,
and the large community variant catalogs) found no prior game combining
these mechanics. Closest relatives: Absurdle (adversarial candidate set, but
stationary) and Weaver (word-ladder graph, but a static puzzle).

## Engine notes

- State is the set `S` of positions consistent with all feedback so far
  (starts at all 2315 answers).
- On a guess, `S` is bucketed by feedback pattern; the host keeps the largest
  bucket (ties: fewer greens, then fewer yellows, then lexicographically
  smallest pattern). All-green is only ever chosen when it is the *only*
  bucket — that is the catch.
- Movement phase: `S := ⋃ ({p} ∪ neighbors(p)) \ scorched`. Since `S` never
  contains scorched words and the quarry may stay, `S` can never go empty.
- Per-turn parent links are recorded so the winning replay is a genuine walk
  through the graph consistent with every color shown.

## Credits & license

MIT — see [LICENSE](LICENSE). QUARRY is an original game inspired by
[Wordle](https://www.nytimes.com/games/wordle/index.html) (a trademark of The
New York Times, which is not affiliated with this project) and by
[Absurdle](https://qntm.org/absurdle)'s adversarial-host idea. Word lists are
the community-circulated Wordle answer/guess lists.
