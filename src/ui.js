// QUARRY UI v1.1 — expects ANSWERS_RAW / GUESSES_RAW and the engine functions
// (newGame, buildAdjacency, isCornered) to be in scope (inlined by build.mjs).
(function () {
  'use strict';

  // ---------- data ----------
  var ANSWERS = ANSWERS_RAW.split(',');
  var GUESSES = GUESSES_RAW.split(',');
  var ADJ = buildAdjacency(ANSWERS);
  var TOTAL = ANSWERS.length;
  var TOTAL_BITS = Math.log2(TOTAL);
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var FLIP_STEP = REDUCED ? 0 : 250;
  var FLIP_DUR = REDUCED ? 0 : 500;

  var $ = function (id) { return document.getElementById(id); };
  var boardWrap = $('board-wrap'), board = $('board'), keyboard = $('keyboard');
  var toastEl = $('toast');

  // ---------- difficulty modes ----------
  var MODES = {
    fawn: { emoji: '🐇', name: 'FAWN', moveEvery: 2, tracker: 50 },
    fox:  { emoji: '🦊', name: 'FOX',  moveEvery: 1, tracker: 25 },
    wolf: { emoji: '🐺', name: 'WOLF', moveEvery: 1, tracker: 0 }
  };
  var MODE_KEY = 'quarry-mode';
  var STATS_KEY = 'quarry_stats_v1';
  var HINT_KEY = 'quarry-tracker-hint';
  var modeId = 'fox';
  try {
    var savedMode = localStorage.getItem(MODE_KEY);
    if (MODES[savedMode]) modeId = savedMode;
  } catch (e) {}

  // ---------- state ----------
  var game = null;
  var cur = '';            // letters being typed
  var activeRow = null;
  var revealing = false;
  var surrendered = false;
  var keyInfo = {};        // letter -> { state: 0|1|2, age: 0..5 }
  var rowsMeta = [];       // { word, pattern, moved } for share text
  var toastTimer = null;
  var replayTimers = [];
  var trackerWasWarm = false;

  function finished() { return !game || game.gameOver || surrendered; }

  // ---------- board ----------
  function makeRow() {
    var row = document.createElement('div');
    row.className = 'row';
    for (var i = 0; i < 5; i++) {
      var t = document.createElement('div');
      t.className = 'tile';
      row.appendChild(t);
    }
    return row;
  }

  function newActiveRow() {
    activeRow = makeRow();
    board.appendChild(activeRow);
    scrollBoard();
  }

  function scrollBoard() {
    boardWrap.scrollTop = boardWrap.scrollHeight;
  }

  function renderActive() {
    if (!activeRow) return;
    for (var i = 0; i < 5; i++) {
      var t = activeRow.children[i];
      var ch = cur[i] || '';
      if (t.textContent !== ch) {
        t.textContent = ch;
        t.classList.toggle('filled', !!ch);
      }
    }
  }

  // ---------- typing ----------
  function addLetter(ch) {
    if (revealing || finished()) return;
    if (cur.length >= 5) return;
    cur += ch;
    renderActive();
  }

  function removeLetter() {
    if (revealing || finished()) return;
    cur = cur.slice(0, -1);
    renderActive();
  }

  function prefillGuess(word) {
    if (revealing || finished()) return;
    cur = word;
    renderActive();
  }

  function rejectGuess(msg) {
    toast(msg);
    if (activeRow) {
      activeRow.classList.remove('shake');
      void activeRow.offsetWidth; // restart animation
      activeRow.classList.add('shake');
    }
  }

  function submitGuess() {
    if (revealing || !game) return;
    if (finished()) { reopenEndOverlay(); return; }
    if (cur.length < 5) { rejectGuess('not enough letters'); return; }
    var word = cur.toLowerCase();
    var rep = game.guess(word);
    if (rep.error) {
      rejectGuess(rep.error === 'already-scorched' ? 'already scorched earth' : 'not in word list');
      return;
    }
    // freeze this row and reveal
    revealing = true;
    var row = activeRow;
    activeRow = null;
    cur = '';
    reveal(row, rep, function () {
      afterReveal(row, rep);
    });
  }

  function reveal(row, rep, done) {
    var i;
    function paint(tile, code) {
      tile.classList.add('s' + code);
      tile.classList.remove('filled');
    }
    if (REDUCED) {
      for (i = 0; i < 5; i++) paint(row.children[i], rep.pattern[i]);
      done();
      return;
    }
    for (i = 0; i < 5; i++) {
      (function (i) {
        var tile = row.children[i];
        setTimeout(function () {
          tile.classList.add('flip');
          setTimeout(function () { paint(tile, rep.pattern[i]); }, FLIP_DUR / 2);
        }, i * FLIP_STEP);
      })(i);
    }
    setTimeout(done, 4 * FLIP_STEP + FLIP_DUR + 60);
  }

  var SCORCH_TIP = 'scorched — the quarry can never enter this word';
  var PAW_TIP = 'the quarry moved after this guess';

  function afterReveal(row, rep) {
    if (rep.scorchedGuess) {
      row.classList.add('scorched');
      row.setAttribute('data-tip', SCORCH_TIP);
      row.setAttribute('title', SCORCH_TIP);
    }
    if (rep.moved) {
      var paw = document.createElement('span');
      paw.className = 'paw-marker';
      paw.setAttribute('aria-label', PAW_TIP);
      paw.setAttribute('data-tip', PAW_TIP);
      paw.setAttribute('title', PAW_TIP);
      paw.innerHTML = '🐾<span class="ghost">🐾</span><span class="ghost g2">🐾</span>';
      row.appendChild(paw);
    }
    rowsMeta.push({ word: rep.guess, pattern: rep.pattern, moved: rep.moved });
    updateKeyboard(rep);
    updateHunt(rep);
    updateTracker();
    revealing = false;
    if (rep.win) {
      recordResult('caught', game.turn);
      setTimeout(showWin, REDUCED ? 0 : 350);
    } else {
      newActiveRow();
    }
  }

  // ---------- on-screen keyboard ----------
  var KB_ROWS = ['qwertyuiop', 'asdfghjkl', '@zxcvbnm#']; // @ = enter, # = backspace

  function buildKeyboard() {
    keyboard.innerHTML = '';
    KB_ROWS.forEach(function (rowStr) {
      var kr = document.createElement('div');
      kr.className = 'kb-row';
      rowStr.split('').forEach(function (ch) {
        var k = document.createElement('button');
        if (ch === '@') {
          k.className = 'key wide';
          k.textContent = 'enter';
          k.dataset.key = 'enter';
          k.setAttribute('aria-label', 'Submit guess');
        } else if (ch === '#') {
          k.className = 'key wide';
          k.innerHTML = '&#9003;';
          k.dataset.key = 'back';
          k.setAttribute('aria-label', 'Delete letter');
        } else {
          k.className = 'key';
          k.textContent = ch;
          k.dataset.key = ch;
          k.setAttribute('aria-label', 'Letter ' + ch.toUpperCase());
        }
        kr.appendChild(k);
      });
      keyboard.appendChild(kr);
    });
  }

  keyboard.addEventListener('click', function (e) {
    var k = e.target.closest('.key');
    if (!k) return;
    var key = k.dataset.key;
    if (key === 'enter') submitGuess();
    else if (key === 'back') removeLetter();
    else addLetter(key);
  });

  function updateKeyboard(rep) {
    var letter, i;
    // stale intel rots: when the quarry moves, all *previous* intel ages a step
    if (rep.moved) {
      for (letter in keyInfo) keyInfo[letter].age = Math.min(5, keyInfo[letter].age + 1);
    }
    // most recent feedback wins outright: reset state + freshness for these keys
    var best = {};
    for (i = 0; i < 5; i++) {
      letter = rep.guess[i];
      var code = +rep.pattern[i];
      if (best[letter] === undefined || code > best[letter]) best[letter] = code;
    }
    for (letter in best) keyInfo[letter] = { state: best[letter], age: 0 };
    applyKeyboard();
  }

  var STALE_TIP = 'faded keys = old intel; the quarry may have moved since';

  function applyKeyboard() {
    var keys = keyboard.querySelectorAll('.key');
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], letter = k.dataset.key;
      if (letter.length !== 1) continue;
      var info = keyInfo[letter];
      if (info) {
        k.dataset.state = info.state;
        k.dataset.age = info.age;
        if (info.age >= 1) {
          k.setAttribute('data-tip', STALE_TIP);
          k.setAttribute('title', STALE_TIP);
        } else {
          k.removeAttribute('data-tip');
          k.removeAttribute('title');
        }
      } else {
        delete k.dataset.state;
        delete k.dataset.age;
        k.removeAttribute('data-tip');
        k.removeAttribute('title');
      }
    }
  }

  // ---------- hunt panel ----------
  var huntPanel = $('hunt-panel'), huntLog = $('hunt-log');

  function fmtBits(x) { return (Math.round(x * 10) / 10).toFixed(1); }

  function updateHuntHeader() {
    var n = game.gameOver ? 1 : game.size;
    $('hides-count').innerHTML = 'possible hides: <b>' + n + '</b> / ' + TOTAL;
    var frac = Math.log2(Math.max(n, 1)) / TOTAL_BITS;
    $('hides-bar-fill').style.width = (frac * 100).toFixed(1) + '%';
    $('bits-line').innerHTML =
      'intel gained: <b>' + fmtBits(game.totalBitsGained) + '</b> of ' + fmtBits(TOTAL_BITS) +
      ' bits needed &middot; leaked back: <b>' + fmtBits(game.totalBitsLeaked) + '</b>';
  }

  function updateHunt(rep) {
    var line = document.createElement('div');
    line.className = 'log-line';
    var html = '<b>' + rep.guess.toUpperCase() + '</b> &mdash; 🔍 filtered ' +
      rep.sizeBefore + '→' + rep.sizeAfterFilter +
      ' (<span class="gain">+' + fmtBits(rep.bitsGained) + ' bits</span>)';
    if (rep.moved) {
      html += ' &middot; 🐾 fled ' + rep.sizeAfterFilter + '→' + rep.sizeAfterMove +
        ' (<span class="leak">−' + fmtBits(rep.bitsLeaked) + '</span>)';
    }
    if (rep.win) html = '<b>' + rep.guess.toUpperCase() + '</b> &mdash; 🏁 cornered. nowhere left to run.';
    line.innerHTML = html;
    huntLog.insertBefore(line, huntLog.firstChild);
    updateHuntHeader();
  }

  $('btn-hunt').addEventListener('click', function () {
    var open = huntPanel.hidden;
    huntPanel.hidden = !open;
    this.setAttribute('aria-pressed', String(open));
  });
  $('btn-hunt-close').addEventListener('click', function () {
    huntPanel.hidden = true;
    $('btn-hunt').setAttribute('aria-pressed', 'false');
  });

  // ---------- tracker (fresh tracks) ----------
  var trackerBody = $('tracker-body');

  function updateTracker() {
    var mode = MODES[modeId];
    trackerBody.className = '';
    if (finished()) {
      trackerBody.innerHTML = '<div class="tracker-cold">' +
        (game && game.gameOver ? 'the hunt is over.' : 'it got away.') + '</div>';
      return;
    }
    if (mode.tracker === 0) {
      trackerBody.innerHTML = '<div class="tracker-cold">the wolf hunts blind — no tracker.</div>';
      return;
    }
    var n = game.size;
    if (n > mode.tracker) {
      trackerBody.innerHTML = '<div class="tracker-cold">trail too cold — ' + n + ' possible hides</div>';
      trackerWasWarm = false;
      return;
    }
    trackerBody.className = 'chips';
    trackerBody.innerHTML = '';
    var scor = game.scorchedSet();
    game.candidates().sort().forEach(function (w) {
      var c = document.createElement('button');
      var cornered = isCornered(w, ADJ, scor);
      c.className = 'chip' + (cornered ? ' cornered' : '');
      c.textContent = w;
      c.dataset.word = w;
      var tip = cornered
        ? 'dead end — it has nowhere left to run from here. strike.'
        : 'a possible hide — click to load it into your row';
      c.setAttribute('data-tip', tip);
      c.setAttribute('title', tip);
      c.setAttribute('aria-label', 'guess ' + w + (cornered ? ' (cornered)' : ''));
      trackerBody.appendChild(c);
    });
    if (!trackerWasWarm) {
      trackerWasWarm = true;
      var seen = false;
      try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch (e) {}
      if (!seen) {
        if (huntPanel.hidden) {
          huntPanel.hidden = false;
          $('btn-hunt').setAttribute('aria-pressed', 'true');
        }
        toast("fresh tracks: it's one of these");
        try { localStorage.setItem(HINT_KEY, '1'); } catch (e) {}
      }
    }
  }

  trackerBody.addEventListener('click', function (e) {
    var c = e.target.closest('.chip');
    if (!c || !c.dataset.word) return;
    prefillGuess(c.dataset.word);
  });

  // ---------- toast ----------
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1700);
  }

  // ---------- modals ----------
  function openModal(m) { m.hidden = false; }
  function closeModal(m) { m.hidden = true; }
  function anyModalOpen() {
    return !$('help-modal').hidden || !$('win-overlay').hidden ||
      !$('lose-overlay').hidden || !$('stats-modal').hidden;
  }
  function closeAllModals() {
    ['help-modal', 'win-overlay', 'lose-overlay', 'stats-modal'].forEach(function (id) {
      closeModal($(id));
    });
  }
  function reopenEndOverlay() {
    if (game && game.gameOver) openModal($('win-overlay'));
    else if (surrendered) openModal($('lose-overlay'));
  }

  document.querySelectorAll('.modal').forEach(function (m) {
    m.addEventListener('click', function (e) {
      if (e.target === m || e.target.closest('[data-close]')) closeModal(m);
    });
  });

  $('btn-help').addEventListener('click', function () { openModal($('help-modal')); });

  // ---------- stats / leaderboard ----------
  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function recordResult(result, moves) {
    var s = loadStats();
    var d = s[modeId] || { games: 0, caught: 0, escaped: 0, bestMoves: null, totalMoves: 0, history: [] };
    d.games += 1;
    if (result === 'caught') {
      d.caught += 1;
      d.totalMoves += moves;
      if (d.bestMoves === null || moves < d.bestMoves) d.bestMoves = moves;
    } else {
      d.escaped += 1;
    }
    d.history.push({ date: new Date().toISOString(), moves: moves, result: result });
    if (d.history.length > 15) d.history = d.history.slice(-15);
    s[modeId] = d;
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function renderStats() {
    var s = loadStats();
    var body = $('stats-body');
    body.innerHTML = '';
    ['fawn', 'fox', 'wolf'].forEach(function (id) {
      var m = MODES[id], d = s[id];
      var card = document.createElement('div');
      card.className = 'stat-card';
      var html = '<h3>' + m.emoji + ' ' + m.name + '</h3>';
      if (!d || !d.games) {
        html += '<div class="stat-none">no hunts yet.</div>';
      } else {
        html += '<div class="stat-line">best: ' +
          (d.bestMoves !== null ? '<span class="best">' + d.bestMoves + ' moves</span>' : '—') +
          ' &middot; avg catch: <b>' +
          (d.caught ? (d.totalMoves / d.caught).toFixed(1) : '—') +
          '</b> &middot; record: <b>' + d.caught + '</b> caught / <b>' + d.escaped + '</b> escaped</div>';
        var recent = d.history.slice(-5).reverse().map(function (h) {
          return (h.result === 'caught' ? '🐾 cornered in ' + h.moves : '🏳 escaped after ' + h.moves) +
            ' &middot; ' + h.date.slice(0, 10);
        }).join('<br>');
        html += '<div class="stat-recent">' + recent + '</div>';
      }
      card.innerHTML = html;
      body.appendChild(card);
    });
  }

  $('btn-stats').addEventListener('click', function () {
    renderStats();
    openModal($('stats-modal'));
  });

  // ---------- surrender ----------
  $('btn-surrender').addEventListener('click', function () {
    if (revealing) return;
    if (finished()) { reopenEndOverlay(); return; }
    if (game.turn === 0) { toast('no hunt to abandon yet — take a shot first'); return; }
    if (!window.confirm('Abandon the hunt? The quarry escapes, and it goes on your record.')) return;
    surrendered = true;
    recordResult('escaped', game.turn);
    updateTracker();
    showLose();
  });

  function showLose() {
    var m = MODES[modeId];
    $('lose-sub').textContent = m.emoji + ' it escaped after ' + game.turn +
      ' move' + (game.turn === 1 ? '' : 's');
    var list = $('hideout-list');
    list.innerHTML = '';
    var hides = game.candidates().sort();
    hides.slice(0, 30).forEach(function (w) {
      var c = document.createElement('span');
      c.className = 'chip';
      c.textContent = w;
      list.appendChild(c);
    });
    if (hides.length > 30) {
      var more = document.createElement('div');
      more.className = 'more';
      more.textContent = '…and ' + (hides.length - 30) + ' more';
      list.appendChild(more);
    }
    openModal($('lose-overlay'));
  }

  $('btn-lose-new').addEventListener('click', function () {
    startGame();
    toast('fresh trail');
  });

  // ---------- win overlay + escape replay ----------
  function showWin() {
    var n = game.turn;
    $('win-sub').textContent = MODES[modeId].emoji + ' caught in ' + n + ' move' + (n === 1 ? '' : 's');
    openModal($('win-overlay'));
    playReplay();
  }

  function clearReplay() {
    replayTimers.forEach(clearTimeout);
    replayTimers = [];
    $('route-chain').innerHTML = '';
  }

  function routeWordEl(word, prev) {
    var el = document.createElement('div');
    el.className = 'route-word';
    for (var i = 0; i < 5; i++) {
      var s = document.createElement('span');
      s.textContent = word[i];
      if (prev && prev[i] !== word[i]) s.className = 'diff';
      el.appendChild(s);
    }
    return el;
  }

  function playReplay() {
    clearReplay();
    var route = game.escapeRoute() || [game.finalWord];
    var chain = $('route-chain');
    var step = REDUCED ? 0 : 600;
    route.forEach(function (word, idx) {
      replayTimers.push(setTimeout(function () {
        if (idx > 0) {
          var arrow = document.createElement('div');
          arrow.className = 'route-arrow';
          arrow.textContent = '↓';
          chain.appendChild(arrow);
        }
        chain.appendChild(routeWordEl(word, idx > 0 ? route[idx - 1] : null));
        chain.scrollTop = chain.scrollHeight;
      }, idx * step));
    });
    if (route.length === 1) {
      replayTimers.push(setTimeout(function () {
        var note = document.createElement('div');
        note.className = 'route-arrow';
        note.textContent = 'it never left.';
        chain.appendChild(note);
      }, step));
    }
  }

  $('btn-replay').addEventListener('click', playReplay);

  // ---------- share ----------
  var EMOJI = { '0': '⬛', '1': '🟨', '2': '🟩' };

  function shareText() {
    var lines = ['QUARRY ' + MODES[modeId].emoji + ' cornered in ' + game.turn];
    rowsMeta.slice(-6).forEach(function (r) {
      var line = r.pattern.split('').map(function (c) { return EMOJI[c]; }).join('');
      if (r.moved) line += ' 🐾';
      lines.push(line);
    });
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(); }
      catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }

  $('btn-share').addEventListener('click', function () {
    copyText(shareText()).then(
      function () { toast('copied to clipboard'); },
      function () { toast('could not copy'); }
    );
  });

  // ---------- color-blind assist ----------
  var cbToggle = $('cb-toggle');
  try {
    if (localStorage.getItem('quarry-cb') === '1') {
      cbToggle.checked = true;
      document.body.classList.add('cb');
    }
  } catch (e) { /* storage unavailable — fine */ }
  cbToggle.addEventListener('change', function () {
    document.body.classList.toggle('cb', this.checked);
    try { localStorage.setItem('quarry-cb', this.checked ? '1' : '0'); } catch (e) {}
  });

  // ---------- difficulty control ----------
  var modeBar = $('mode-bar');

  function renderModeBar() {
    modeBar.querySelectorAll('.mode-seg').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.mode === modeId));
    });
  }

  modeBar.addEventListener('click', function (e) {
    var b = e.target.closest('.mode-seg');
    if (!b || b.dataset.mode === modeId) return;
    if (game && game.turn > 0 && !finished()) {
      if (!window.confirm('Change difficulty? This abandons the current trail and starts a new hunt (nothing is recorded).')) return;
    }
    modeId = b.dataset.mode;
    try { localStorage.setItem(MODE_KEY, modeId); } catch (e2) {}
    renderModeBar();
    startGame();
    toast(MODES[modeId].emoji + ' ' + MODES[modeId].name.toLowerCase() + ' hunt begins');
  });

  // ---------- physical keyboard ----------
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { closeAllModals(); return; }
    if (anyModalOpen()) return;
    if (e.key === 'Enter') { submitGuess(); return; }
    if (e.key === 'Backspace') { removeLetter(); return; }
    if (/^[a-zA-Z]$/.test(e.key)) addLetter(e.key.toLowerCase());
  });

  // ---------- new game ----------
  function startGame() {
    game = newGame({
      answers: ANSWERS, allowed: GUESSES, adjacency: ADJ,
      moveEveryNTurns: MODES[modeId].moveEvery
    });
    cur = '';
    revealing = false;
    surrendered = false;
    trackerWasWarm = false;
    keyInfo = {};
    rowsMeta = [];
    board.innerHTML = '';
    huntLog.innerHTML = '';
    clearReplay();
    closeModal($('win-overlay'));
    closeModal($('lose-overlay'));
    applyKeyboard();
    updateHuntHeader();
    updateTracker();
    newActiveRow();
  }

  $('btn-new').addEventListener('click', function () {
    startGame();
    toast('fresh trail');
  });

  // ---------- boot ----------
  buildKeyboard();
  renderModeBar();
  startGame();
  // hunt panel starts open on wide screens
  if (window.innerWidth >= 900) {
    huntPanel.hidden = false;
    $('btn-hunt').setAttribute('aria-pressed', 'true');
  }
})();
