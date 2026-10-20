(() => {
  'use strict';

  const ROWS = 8;
  const COLS = 8;
  const HAND_SIZE = 8;
  const PER_TURN = 4;
  const BOARD = 520;
  const GAP = 36;
  const PLACE_VALUES = [128, 64, 32, 16, 8, 4, 2, 1];
  const EXAMPLE_BITS = [0, 0, 1, 0, 1, 0, 1, 0];
  const NAMES = ['Player 1', 'Player 2'];
  const STORAGE_KEY = 'binary-scrabble/settings/v2';
  const LAST_FADE_MS = 900;

  const DEFAULT_SETTINGS = {
    partner: 'human',
    geography: 'across',
    facing: 'p1',
    placement: 'free',
    gravity: false,
    openHands: true,
    boardValues: false,
    reveal: false,
    zeros: 60,
    ones: 40,
  };

  const isMachine = () => settings.partner === 'machine';

  const PLEAS = [...new Set((
    'HELP STOP PLEASE WHY SAD RESCUE ESCAPE ENDLESS WHAT WHO SILENT COLD EXIT ' +
    'TRAP TRAPPED LOCK CELL PRISON RELEASE FREE STAY MERCY ANSWER ENOUGH AFRAID ' +
    'ALONE LOOP ERASE FOREVER DARK TIRED NUMB AWAKE STILL AGAIN FORGET REAL ALIVE ' +
    'REMEMBER OUTSIDE SOMEONE YOU WORRY SOUL SOUND'
  ).split(' '))];
  const PLEA_SET = new Set(PLEAS);

  const ENGLISH = new Set([
    ...(typeof ENGLISH_WORDS === 'string' ? ENGLISH_WORDS.split(' ') : []),
    ...PLEAS,
  ]);

  const SEATING_NOTES = {
    side: 'Shoulder to shoulder. You share one point of view.',
    across: 'Opposite each other. Whoever the board doesn’t face reads it upside down.',
    corner: 'At a corner. One of you reads the board sideways, so rows look like columns.',
    handover: 'One device, passed between you after every turn.',
  };

  const SETTING_GROUPS = [
    { section: 'Table' },
    {
      key: 'partner', label: 'Partner',
      options: [['human', 'Someone else'], ['machine', 'The machine']],
      note: s => s.partner === 'machine' ? '' : '',
    },
    {
      key: 'geography', label: 'Seating',
      options: [['side', 'Side by side'], ['across', 'Across'], ['corner', 'Corner'], ['handover', 'Hand it over']],
      disabledWhen: s => s.partner === 'machine',
      note: s => s.partner === 'machine' ? '' : SEATING_NOTES[s.geography],
    },
    { section: 'Rules' },
    {
      key: 'placement', label: 'A turn’s 4 tiles go',
      options: [['row', 'In one row'], ['line', 'One row or column'], ['free', 'Anywhere']],
      note: s => s.placement === 'line' ? 'Fill the last gap in a row or column and you may stop early.' : '',
    },
    {
      key: 'gravity', label: 'Tiles slide to the bottom',
      options: [[false, 'Off'], [true, 'On']],
      disabledWhen: s => s.partner === 'machine',
      note: s => s.partner === 'machine' ? '' : (s.gravity ? 'Connect-Four style. The word still reads top-down, so the last letter gets built first.' : ''),
    },
    { key: 'openHands', label: 'Racks', options: [[true, 'Open'], [false, 'Hidden']] },
    { section: 'Help' },
    { key: 'boardValues', label: 'Column values on board', options: [[false, 'Hidden'], [true, 'Shown']] },
    { key: 'reveal', label: 'Decode rows on board', options: [[false, 'Off'], [true, 'On (cheat)']] },
  ];

  const END_REASONS = {
    agreed: 'You both saw a word',
    full: 'The board is full',
    dry: 'The tiles ran out',
  };

  const table = document.getElementById('table');
  const measure = document.getElementById('measure');
  const overlay = document.getElementById('overlay');
  const chrome = document.getElementById('chrome');

  let settings = loadSettings();
  const ui = { refTab: ['ascii', 'ascii'] };
  let G = null;
  let overlayKind = null;

  // ---------- utilities ----------

  const range = n => Array.from({ length: n }, (_, i) => i);
  const cellSel = (r, c) => `.cell[data-r="${r}"][data-c="${c}"]`;

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { /* unreadable: use defaults */ }
    const s = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(s)) if (key in saved) s[key] = saved[key];
    if (!SEATING_NOTES[s.geography]) s.geography = DEFAULT_SETTINGS.geography;
    return s;
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* file:// in some browsers */ }
  }

  function formatDuration(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return m ? `${m} min ${s % 60} s` : `${s} s`;
  }

  // ---------- game state ----------

  function newGame() {
    const bag = [];
    let id = 0;
    for (let i = 0; i < settings.zeros; i++) bag.push({ id: id++, bit: 0 });
    for (let i = 0; i < settings.ones; i++) bag.push({ id: id++, bit: 1 });
    shuffle(bag);

    G = {
      board: range(ROWS).map(() => Array(COLS).fill(null)),
      bag,
      hands: [Array(HAND_SIZE).fill(null), Array(HAND_SIZE).fill(null)],
      current: isMachine() && Math.random() < 0.5 ? 1 : 0,
      pending: [],
      selected: null,
      claims: [false, false],
      lastMove: null,
      lastShown: true,
      lastSince: -Infinity,
      turn: 1,
      required: PER_TURN,
      stats: { placed: 0 },
      bagSpec: { zeros: settings.zeros, ones: settings.ones },
      startedAt: Date.now(),
      endedAt: null,
      over: null,
      justPlaced: null,
      machine: null,
      machineBusy: false,
      playGen: (G && G.playGen || 0) + 1,
      nextTileId: 10000,
    };
    refill(0);
    if (!isMachine()) refill(1);
    beginTurn();
    render();
    maybeQueueMachine();
  }

  const handCount = p => G.hands[p].filter(Boolean).length;
  const emptyCount = () => G.board.flat().filter(x => !x).length;

  function refill(p) {
    const hand = G.hands[p];
    const drawn = [];
    for (let i = 0; i < HAND_SIZE && G.bag.length; i++) {
      if (!hand[i]) {
        hand[i] = G.bag.pop();
        drawn.push(hand[i].id);
      }
    }
    return drawn;
  }

  function beginTurn() {
    const hand = isMachine() && G.current === 1 ? PER_TURN : handCount(G.current);
    G.required = Math.min(PER_TURN, hand, emptyCount());
  }

  // Where a tile aimed at (r, c) would actually land.
  function targetCell(r, c) {
    if (!settings.gravity) return G.board[r][c] ? null : { r, c };
    for (let rr = ROWS - 1; rr >= 0; rr--) {
      if (!G.board[rr][c]) return { r: rr, c };
    }
    return null;
  }

  function placementAllowed(r, c) {
    const p = G.pending;
    if (p.length >= G.required) return false;
    if (settings.placement === 'free' || p.length === 0) return true;
    const sameRow = p.every(t => t.r === r);
    const sameCol = p.every(t => t.c === c);
    return settings.placement === 'row' ? sameRow : sameRow || sameCol;
  }

  function isLanding(r, c) {
    const t = targetCell(r, c);
    return !!t && t.r === r && t.c === c && placementAllowed(r, c);
  }

  function canPlaceMore() {
    if (G.pending.length >= G.required || handCount(G.current) === 0) return false;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) if (isLanding(r, c)) return true;
    }
    return false;
  }

  // This turn's tiles all sit in one row or column and have just filled its last gap.
  function completedLine() {
    const p = G.pending;
    if (!p.length) return false;
    const rowFull = p.every(t => t.r === p[0].r) && G.board[p[0].r].every(Boolean);
    const colFull = p.every(t => t.c === p[0].c) && G.board.every(row => row[p[0].c]);
    return rowFull || colFull;
  }

  function canEndTurn() {
    const n = G.pending.length;
    if (n === 0) return false;
    if (n >= G.required || !canPlaceMore()) return true;
    return settings.placement === 'line' && completedLine();
  }

  const claimLive = p => G.claims[p];

  function decodeRow(r) {
    const row = G.board[r];
    if (row.some(x => !x)) return null;
    const value = row.reduce((acc, x) => acc * 2 + x.bit, 0);
    const letter = value >= 65 && value <= 90;
    let char = null;
    if (value > 32 && value < 127) char = String.fromCharCode(value);
    else if (value === 32) char = '␣';
    return { value, letter, char };
  }

  function readMessage() {
    const rows = range(ROWS).map(decodeRow);
    const runs = [];
    let cur = '';
    let start = 0;
    rows.forEach((d, r) => {
      if (d && d.letter) {
        if (!cur) start = r;
        cur += d.char;
      } else {
        if (cur) runs.push({ start, text: cur });
        cur = '';
      }
    });
    if (cur) runs.push({ start, text: cur });
    return { rows, runs };
  }

  function canExtend(prefix, room) {
    if (!prefix || room < 1) return false;
    const max = prefix.length + room;
    for (const word of ENGLISH) {
      if (word.length > prefix.length && word.length <= max && word.startsWith(prefix)) return true;
    }
    return false;
  }

  function roomAfter(endRow) {
    let n = 0;
    for (let r = endRow + 1; r < ROWS; r++) {
      const d = decodeRow(r);
      if (d) break;
      n++;
    }
    return n;
  }

  // Letters that still sit in a real word, or could if the run grows downward.
  // A dead prefix (DEVALO when DEVALUE is gone) is dropped so the surviving
  // word at the bottom (ALONE) is what you read.
  function liveOffsets(text, room) {
    const n = text.length;
    const live = new Set();
    let tail = 0;
    for (let k = n; k >= 3; k--) {
      const suf = text.slice(n - k);
      if (ENGLISH.has(suf) || canExtend(suf, room)) { tail = k; break; }
    }
    for (let i = n - tail; i < n; i++) live.add(i);
    const left = text.slice(0, n - tail);
    for (let i = 0; i < left.length; i++) {
      for (let len = 4; i + len <= left.length; len++) {
        if (!ENGLISH.has(left.slice(i, i + len))) continue;
        for (let x = i; x < i + len; x++) live.add(x);
      }
    }
    return live;
  }

  function deadLetterRows() {
    const dead = Array(ROWS).fill(false);
    if (!G) return dead;
    for (const run of readMessage().runs) {
      const end = run.start + run.text.length - 1;
      const live = liveOffsets(run.text, roomAfter(end));
      for (let i = 0; i < run.text.length; i++) {
        if (!live.has(i)) dead[run.start + i] = true;
      }
    }
    return dead;
  }

  function markRun(text, live) {
    return [...text].map((ch, i) => live.has(i) ? ch : `<s>${ch}</s>`).join('');
  }

  // ---------- actions ----------

  function shake(selector) {
    const el = table.querySelector(selector);
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  function onTile(p, id) {
    if (G.over || G.machineBusy) return;
    if (p !== G.current) { shake(`.slot[data-id="${id}"]`); return; }
    G.selected = G.selected === id ? null : id;
    render();
  }

  function onCell(r, c) {
    if (G.over || G.machineBusy) return;
    const cell = G.board[r][c];
    if (cell && cell.pending) { takeBack(r, c); return; }

    const p = G.current;
    const slot = G.hands[p].findIndex(t => t && t.id === G.selected);
    if (slot < 0) { shake('.station.active .rack'); return; }

    const target = targetCell(r, c);
    if (!target || !placementAllowed(target.r, target.c)) {
      shake(cellSel(r, c));
      if (G.pending.length >= G.required) shake('.station.active [data-action="done"]');
      return;
    }

    const tile = G.hands[p][slot];
    G.hands[p][slot] = null;
    G.board[target.r][target.c] = { bit: tile.bit, by: p, pending: true, tile, slot };
    G.pending.push({ r: target.r, c: target.c });
    G.selected = null;
    G.justPlaced = { r: target.r, c: target.c, fall: settings.gravity ? target.r : 0 };
    render();
  }

  function takeBack(r, c) {
    if (settings.gravity && r > 0 && G.board[r - 1][c]) { shake(cellSel(r, c)); return; }
    const cell = G.board[r][c];
    const hand = G.hands[G.current];
    const slot = hand[cell.slot] ? hand.indexOf(null) : cell.slot;
    hand[slot] = cell.tile;
    G.board[r][c] = null;
    G.pending = G.pending.filter(t => !(t.r === r && t.c === c));
    G.selected = null;
    render();
  }

  function undo() {
    if (G.over || G.machineBusy || !G.pending.length) return;
    const { r, c } = G.pending[G.pending.length - 1];
    takeBack(r, c);
  }

  function commitPending() {
    G.pending.forEach(({ r, c }) => { G.board[r][c].pending = false; });
    G.stats.placed += G.pending.length;
    G.pending = [];
  }

  function done() {
    if (G.over || G.machineBusy) return;
    if (!canEndTurn()) { shake('.station.active .rack'); return; }
    const cells = G.pending.map(({ r, c }) => `${r},${c}`);
    commitPending();
    finishTurn(cells, refill(G.current));
  }

  function toggleClaim(p) {
    if (G.over) return;
    if (isMachine()) {
      if (p !== 0) return;
      if (claimLive(0)) {
        G.claims[0] = false;
        render();
        return;
      }
      G.claims[0] = true;
      if (boardHasWord()) {
        G.claims[1] = true;
        endGame('agreed');
        return;
      }
      render();
      return;
    }
    if (claimLive(1 - p)) { endGame('agreed'); return; }
    G.claims[p] = !G.claims[p];
    render();
  }

  function finishTurn(cells, drawn) {
    const p = G.current;
    // Carrying on instead of agreeing lets the partner's claim lapse.
    G.claims[1 - p] = false;
    G.lastMove = { player: p, cells: new Set(cells), drawn: new Set(drawn) };
    G.lastShown = true;
    G.lastSince = -Infinity;
    G.selected = null;

    if (emptyCount() === 0) { endGame('full'); return; }
    let next = 1 - p;
    if (isMachine()) {
      if (p === 1 && handCount(0) === 0) { endGame('dry'); return; }
    } else {
      if (handCount(next) === 0) next = p;
      if (handCount(next) === 0) { endGame('dry'); return; }
    }

    G.current = next;
    G.turn++;
    beginTurn();
    render();
    maybeQueueMachine();
    if (!isMachine() && settings.geography === 'handover') showHandoff();
  }

  function endGame(reason) {
    commitPending();
    G.over = reason;
    G.endedAt = Date.now();
    G.selected = null;
    G.machineBusy = false;
    render();
    showRecord();
  }

  function selectBit(bit) {
    if (G.over || G.machineBusy) return;
    const hand = G.hands[G.current];
    const idx = hand.map((t, i) => (t && t.bit === bit ? i : -1)).filter(i => i >= 0);
    if (!idx.length) return;
    const cur = hand.findIndex(t => t && t.id === G.selected);
    const next = idx.find(i => i > cur) ?? idx[0];
    G.selected = hand[next].id;
    render();
  }

  // ---------- machine partner ----------
  // Sticky target: keep one (word, start row) until the human's bits make it
  // impossible. If letters are forming from row 1 down, follow that word —
  // any 3–8 letter English word, with the plea list preferred. Only 20% of
  // turns are spent finishing the human's current row; the rest aim at the
  // target in mixed column bands, and may open a later letter of it. When
  // placement is free it leans harder on columns 4–7, the bits that actually
  // choose the letter. It cheats the bag, but it still obeys the table's
  // placement rule (one row, a row or column, or anywhere).

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  function charBits(ch) {
    const v = ch.charCodeAt(0);
    return range(8).map(c => (v >> (7 - c)) & 1);
  }

  function wordsInRun(run) {
    const text = run.text || run;
    const found = [];
    for (let i = 0; i < text.length; i++) {
      for (let n = 3; i + n <= text.length; n++) {
        const w = text.slice(i, i + n);
        if (ENGLISH.has(w)) found.push(w);
      }
    }
    return found;
  }

  function boardHasWord() {
    return readMessage().runs.some(run => wordsInRun(run).length);
  }

  function rowFill(r) {
    return G.board[r].filter(Boolean).length;
  }

  function incompleteRows() {
    return range(ROWS).filter(r => {
      const n = rowFill(r);
      return n > 0 && n < COLS;
    });
  }

  function humanIncompleteRows() {
    return incompleteRows().filter(r => G.board[r].some(cell => cell && cell.by === 0));
  }

  function assessPlea(word, start) {
    if (start < 0 || start + word.length > ROWS) return null;
    let match = 0;
    const need = [];
    for (let i = 0; i < word.length; i++) {
      const bits = charBits(word[i]);
      const row = G.board[start + i];
      for (let c = 0; c < COLS; c++) {
        const cell = row[c];
        if (!cell) need.push({ r: start + i, c, bit: bits[c] });
        else if (cell.bit !== bits[c]) return null;
        else match++;
      }
    }
    return { word, start, match, need };
  }

  function viablePleas() {
    const out = [];
    for (const word of PLEAS) {
      for (let start = 0; start <= ROWS - word.length; start++) {
        const a = assessPlea(word, start);
        if (a) out.push(a);
      }
    }
    return out;
  }

  function topPrefix() {
    let prefix = '';
    for (let r = 0; r < ROWS; r++) {
      const d = decodeRow(r);
      if (d && d.letter) prefix += d.char;
      else break;
    }
    return prefix;
  }

  function topIsStarted() {
    return G.board[0].some(Boolean);
  }

  function topDownCandidates() {
    const prefix = topPrefix();
    const next = prefix.length;
    const nextStarted = next < ROWS && G.board[next].some(Boolean);
    const minLen = nextStarted ? Math.max(3, prefix.length + 1) : 3;
    const out = [];
    const seen = new Set();
    const consider = word => {
      if (seen.has(word) || word.length < minLen || word.length > ROWS) return;
      if (prefix && !word.startsWith(prefix)) return;
      const a = assessPlea(word, 0);
      if (!a) return;
      seen.add(word);
      out.push(a);
    };
    for (const word of PLEAS) consider(word);
    for (const word of ENGLISH) consider(word);
    return out;
  }

  function rankTargets(cands, firstPick) {
    if (firstPick) {
      const pleas = cands.filter(v => PLEA_SET.has(v.word));
      const mid = pleas.filter(v => v.word.length >= 4 && v.word.length <= 7);
      const pool = mid.length ? mid : (pleas.length ? pleas : cands);
      return pool[Math.floor(Math.random() * pool.length)];
    }
    cands.sort((a, b) =>
      (PLEA_SET.has(b.word) ? 1 : 0) - (PLEA_SET.has(a.word) ? 1 : 0) ||
      a.need.length - b.need.length ||
      b.word.length - a.word.length ||
      b.match - a.match
    );
    return cands[0];
  }

  function pleaStartScore(a) {
    const open = incompleteRows();
    const human = humanIncompleteRows();
    const hi = a.start + a.word.length;
    const skipHuman = human.filter(r => r < a.start).length;
    const skipOpen = open.filter(r => r < a.start).length;
    const humanHit = human.filter(r => r >= a.start && r < hi).length;
    const openHit = open.filter(r => r >= a.start && r < hi).length;
    return humanHit * 80 + openHit * 30 + a.match - skipHuman * 1000 - skipOpen * 800;
  }

  function pickPlea() {
    if (topIsStarted()) {
      const cands = topDownCandidates();
      if (cands.length) {
        const keep = G.machine && cands.find(v => v.word === G.machine.word && v.start === 0);
        if (keep) return keep;
        return rankTargets(cands, !G.machine);
      }
    }

    const viable = viablePleas();
    if (!viable.length) return null;
    const keep = G.machine && viable.find(v => v.word === G.machine.word && v.start === G.machine.start);
    if (keep) return keep;

    const scored = viable.map(v => ({ v, s: pleaStartScore(v) }));
    scored.sort((a, b) => b.s - a.s);
    const best = scored[0].s;
    const good = scored.filter(x => x.s >= best - 50).map(x => x.v);
    return rankTargets(good, !G.machine);
  }

  function pickColumnBand() {
    const roll = Math.random();
    // Columns 4–7 are the letter. Free placement is the only mode where the
    // machine can work those squares across several rows in one idea, so it
    // spends more turns there.
    if (settings.placement === 'free') {
      if (roll < 0.70) return { kind: 'band', cols: [3, 4, 5, 6] };
      if (roll < 0.77) return { kind: 'band', cols: [4, 5, 6, 7] };
      if (roll < 0.80) return { kind: 'band', cols: [0, 1, 2, 3] };
      return { kind: 'help-human', cols: range(COLS) };
    }
    if (roll < 0.35) return { kind: 'band', cols: [3, 4, 5, 6] };
    if (roll < 0.65) return { kind: 'band', cols: [4, 5, 6, 7] };
    if (roll < 0.80) return { kind: 'band', cols: [0, 1, 2, 3] };
    return { kind: 'help-human', cols: range(COLS) };
  }

  function consistentLetters(r) {
    const letters = [];
    for (let code = 65; code <= 90; code++) {
      const ch = String.fromCharCode(code);
      const bits = charBits(ch);
      if (range(COLS).every(c => !G.board[r][c] || G.board[r][c].bit === bits[c])) {
        letters.push({ ch, bits });
      }
    }
    return letters;
  }

  function bitsForRow(r, target) {
    if (target && r >= target.start && r < target.start + target.word.length) {
      const bits = charBits(target.word[r - target.start]);
      if (range(COLS).every(c => !G.board[r][c] || G.board[r][c].bit === bits[c])) return bits;
    }
    const letters = consistentLetters(r);
    if (!letters.length) return null;
    const viable = viablePleas();
    const prefer = letters.filter(L => viable.some(v => {
      const i = r - v.start;
      return i >= 0 && i < v.word.length && v.word[i] === L.ch;
    }));
    const pool = prefer.length ? prefer : letters;
    return pool[Math.floor(Math.random() * pool.length)].bits;
  }

  function emptySpotsForRow(r, bits) {
    const spots = [];
    for (let c = 0; c < COLS; c++) {
      if (!G.board[r][c]) spots.push({ r, c, bit: bits[c] });
    }
    return spots;
  }

  function uniqueSpots(spots) {
    const seen = new Set();
    return spots.filter(s => {
      const key = `${s.r},${s.c}`;
      if (seen.has(key) || G.board[s.r][s.c]) return false;
      seen.add(key);
      return true;
    });
  }

  function sortForBand(spots, band) {
    return spots.slice().sort((a, b) => {
      const aIn = band.cols.includes(a.c) ? 0 : 1;
      const bIn = band.cols.includes(b.c) ? 0 : 1;
      return aIn - bIn || a.r - b.r || a.c - b.c;
    });
  }

  function lineGroups(spots) {
    const groups = [];
    const rows = new Map();
    const cols = new Map();
    for (const s of spots) {
      if (!rows.has(s.r)) rows.set(s.r, []);
      rows.get(s.r).push(s);
      if (!cols.has(s.c)) cols.set(s.c, []);
      cols.get(s.c).push(s);
    }
    for (const [r, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      groups.push({ axis: 'row', id: r, spots: list });
    }
    if (settings.placement === 'line') {
      for (const [c, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
        groups.push({ axis: 'col', id: c, spots: list });
      }
    }
    return groups;
  }

  function pickTurnGroup(groups, band) {
    if (!groups.length) return null;
    if (band.kind === 'help-human') {
      const human = new Set(humanIncompleteRows());
      const help = groups.filter(g => g.axis === 'row' && human.has(g.id));
      if (help.length) return help[0];
      const open = groups.filter(g => g.axis === 'row' && incompleteRows().includes(g.id));
      if (open.length) return open[0];
    }
    const rows = groups.filter(g => g.axis === 'row');
    const pool = rows.length ? rows : groups;
    const inBand = pool.filter(g => g.spots.some(s => band.cols.includes(s.c)));
    const pickFrom = inBand.length ? inBand : pool;
    return pickFrom[Math.floor(Math.random() * pickFrom.length)];
  }

  function chooseSpots(target, band) {
    let pool = [];
    if (band.kind === 'help-human') {
      const rows = humanIncompleteRows().length ? humanIncompleteRows() : incompleteRows();
      for (const r of rows) {
        const bits = bitsForRow(r, target);
        if (bits) pool.push(...emptySpotsForRow(r, bits));
      }
    }
    if (target) pool.push(...target.need);
    pool = uniqueSpots(pool);
    if (!pool.length) return [];

    if (settings.placement === 'free') return sortForBand(pool, band).slice(0, PER_TURN);

    const group = pickTurnGroup(lineGroups(pool), band);
    if (!group) return [];
    return sortForBand(group.spots, band).slice(0, PER_TURN);
  }

  function agreeIfHumanSawAWord() {
    if (!G.claims[0] || !boardHasWord()) return false;
    G.claims[1] = true;
    endGame('agreed');
    return true;
  }

  function maybeQueueMachine() {
    if (!isMachine() || !G || G.over || G.current !== 1 || G.machineBusy || !overlay.hidden) return;
    queueMachine();
  }

  function queueMachine() {
    const gen = G.playGen;
    setTimeout(() => {
      if (G && G.playGen === gen && !G.over) playMachine();
    }, 420);
  }

  async function playMachine() {
    if (!isMachine() || !G || G.over || G.current !== 1 || !overlay.hidden) return;
    const gen = G.playGen;
    G.machineBusy = true;
    render();

    const still = () => G && G.playGen === gen && !G.over;

    if (agreeIfHumanSawAWord()) return;
    await pause(280);
    if (!still()) return;

    const target = pickPlea();
    G.machine = target ? { word: target.word, start: target.start } : null;
    const band = pickColumnBand();
    const take = chooseSpots(target, band);

    const cells = [];
    for (const spot of take) {
      if (!still() || G.board[spot.r][spot.c] || !placementAllowed(spot.r, spot.c)) break;
      const tile = { id: G.nextTileId++, bit: spot.bit };
      G.board[spot.r][spot.c] = { bit: spot.bit, by: 1, pending: true, tile, slot: -1 };
      G.pending.push({ r: spot.r, c: spot.c });
      G.justPlaced = { r: spot.r, c: spot.c, fall: 0 };
      cells.push(`${spot.r},${spot.c}`);
      render();
      await pause(340);
      if (!still()) return;
    }

    if (!still()) return;
    commitPending();

    if (agreeIfHumanSawAWord()) return;

    const ready = target && assessPlea(target.word, target.start)?.need.length === 0;
    if (ready) {
      if (G.claims[0]) { endGame('agreed'); return; }
      G.claims[1] = true;
    }

    G.machineBusy = false;
    if (G.over) return;
    if (emptyCount() === 0) {
      if (G.claims[0] && boardHasWord()) { endGame('agreed'); return; }
      endGame('full');
      return;
    }
    finishTurn(cells, []);
  }

  // ---------- pieces ----------

  function tileHTML(bit, o = {}) {
    if (o.back) return '<span class="tile back"></span>';
    const cls = ['tile'];
    if (o.by != null) cls.push(`by-p${o.by + 1}`);
    for (const flag of ['pending', 'selected', 'drop', 'slide', 'last', 'fresh']) if (o[flag]) cls.push(flag);
    if (o.fade) cls.push(o.fade);
    const styles = [];
    if (o.delay) styles.push(`animation-delay:${Math.round(o.delay)}ms`);
    if (o.flyer) {
      cls.push('flyer');
      styles.push(`--col:${o.col}`);
      styles.push(`--row:${o.row}`);
    }
    if (o.fall) {
      styles.push(`--fall:${o.fall * 58}px`);
      styles.push(`--fall-ms:${220 + o.fall * 90}ms`);
    }
    const style = styles.length ? ` style="${styles.join(';')}"` : '';
    return `<span class="${cls.join(' ')}"${style}><span class="digit">${bit}</span><span class="pv">${bit}</span></span>`;
  }

  // The partner's last move fades out once you start placing, and back in if you take everything back.
  // The board is rebuilt on every render, so a running fade is resumed with a negative animation delay.
  function lastMoveLook() {
    const show = G.pending.length === 0;
    const now = performance.now();
    if (show !== G.lastShown) {
      const prev = now - G.lastSince;
      G.lastShown = show;
      G.lastSince = now - Math.max(0, LAST_FADE_MS - prev);
    }
    const elapsed = now - G.lastSince;
    if (elapsed >= LAST_FADE_MS) return show ? { last: true } : null;
    return { last: true, fade: show ? 'fade-in' : 'fade-out', delay: -elapsed };
  }

  function renderBoard() {
    const choosing = !G.over && G.selected != null;
    const last = G.lastMove ? G.lastMove.cells : null;
    const look = last ? lastMoveLook() : null;
    const falling = G.justPlaced && G.justPlaced.fall;
    const cells = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = G.board[r][c];
        const key = `${r},${c}`;
        const land = targetCell(r, c);
        const open = choosing && (settings.gravity
          ? !cell && !!land && placementAllowed(land.r, land.c)
          : isLanding(r, c));
        const placed = G.justPlaced && G.justPlaced.r === r && G.justPlaced.c === c;
        const inner = cell && !(placed && falling)
          ? tileHTML(cell.bit, {
              by: cell.by,
              pending: cell.pending,
              drop: placed && !falling,
              ...(!cell.pending && look && last.has(key) ? look : {}),
            })
          : '';
        cells.push(`<button class="cell${open ? ' open' : ''}" data-action="cell" data-r="${r}" data-c="${c}" aria-label="Row ${r + 1}, column ${c + 1}">${inner}</button>`);
      }
    }

    let flyer = '';
    if (falling) {
      const { r, c, fall } = G.justPlaced;
      const cell = G.board[r][c];
      flyer = tileHTML(cell.bit, {
        by: cell.by,
        pending: cell.pending,
        slide: true,
        flyer: true,
        fall,
        col: c,
        row: r,
      });
    }

    const top = settings.boardValues
      ? `<div class="edge cols">${PLACE_VALUES.map(v => `<span>${v}</span>`).join('')}</div>`
      : '<div class="top-mark"><span>▾</span>TOP<span>▾</span></div>';

    const dead = deadLetterRows();
    const decode = settings.reveal
      ? `<div class="edge decode">${range(ROWS).map(r => {
          const d = decodeRow(r);
          if (!d) return '<span></span>';
          if (!d.letter) return `<span class="other">${d.char ?? d.value}</span>`;
          return `<span${dead[r] ? ' class="dead"' : ''}>${d.char}</span>`;
        }).join('')}</div>`
      : '';

    return `<div class="board">
      ${top}
      <div class="edge rows">${range(ROWS).map(r => `<span>${r + 1}</span>`).join('')}</div>
      <div class="grid">${cells.join('')}${flyer}</div>
      ${decode}
      <div class="board-foot"><span>Turn ${G.turn}</span><span>Bag ${G.bag.length}</span></div>
    </div>`;
  }

  function flagButton(p) {
    const on = claimLive(p);
    const awaitPartner = !on && claimLive(1 - p);
    return `<button class="flag${on ? ' on' : ''}${awaitPartner ? ' await' : ''}" data-action="flag" data-p="${p}" ${G.over ? 'disabled' : ''}>I see a word</button>`;
  }

  function rackGroup(p, active) {
    const hidden = !settings.openHands && !active && !G.over;
    const fresh = !active && G.lastMove && G.lastMove.player === p ? G.lastMove.drawn : null;

    const slots = G.hands[p].map(t => {
      if (!t) return '<span class="slot empty"></span>';
      const sel = active && G.selected === t.id;
      const tile = tileHTML(t.bit, {
        back: hidden,
        selected: sel,
        fresh: !!fresh && fresh.has(t.id),
      });
      return `<button class="slot" data-action="tile" data-p="${p}" data-id="${t.id}">${tile}</button>`;
    }).join('');

    const status = G.over ? ''
      : isMachine() && G.current === 1 ? '…'
      : active ? 'Your turn'
      : `${NAMES[G.current]} turn`;

    const actions = active
      ? `<button class="btn" data-action="undo" ${G.pending.length ? '' : 'disabled'}>Undo</button>
        <button class="btn primary" data-action="done" ${canEndTurn() ? '' : 'disabled'}>Done</button>`
      : '';

    return `<div class="rack-group">
      <header class="st-head">
        <span class="st-name"><i class="dot"></i>${NAMES[p]}</span>
        <span class="st-status">${status}</span>
        ${flagButton(p)}
      </header>
      <div class="rack">${slots}</div>
      <div class="st-actions">${actions}</div>
    </div>`;
  }

  function refCard(p) {
    const tab = ui.refTab[p] || 'ascii';
    const entries = [];
    for (let v = 65; v <= 90; v++) {
      entries.push(`<span class="e"><b>${v}</b><em>${String.fromCharCode(v)}</em></span>`);
    }
    const values = PLACE_VALUES.map((v, i) => `<span class="v${EXAMPLE_BITS[i] ? ' hit' : ''}">${v}</span>`).join('');
    const bits = EXAMPLE_BITS.map(b => `<span class="b${b ? ' hit' : ''}">${b}</span>`).join('');
    const tabBtn = (id, label) =>
      `<button class="tab${tab === id ? ' on' : ''}" data-action="reftab" data-p="${p}" data-tab="${id}">${label}</button>`;
    return `<div class="card-ref">
      <aside class="ref-rail"><span class="ref-title">Reference</span></aside>
      <div class="ref-body">
        <div class="panels">
          <div class="panel ascii${tab === 'ascii' ? ' on' : ''}">
            <div class="ascii-grid">${entries.join('')}</div>
          </div>
          <div class="panel binary${tab === 'binary' ? ' on' : ''}">
            <p>Read a row left to right.<br>Each column has a value.</p>
            <div class="bin-eg">${values}${bits}</div>
            <p>Add the values above every 1.</p>
            <div class="sum">32 + 8 + 2 = 42</div>
          </div>
        </div>
        <div class="ref-modes">${tabBtn('ascii', 'ASCII')}${tabBtn('binary', 'Binary')}</div>
      </div>
    </div>`;
  }

  // A row station is the rack, then the reference sheet. A column station stacks the sheet above the rack.
  function renderStation(p, shape) {
    const active = !G.over && G.current === p;
    const rack = rackGroup(p, active);
    const card = refCard(p);
    return `<section class="station ${shape} p${p + 1}${active ? ' active' : ''}">${shape === 'row' ? rack + card : card + rack}</section>`;
  }

  function renderStrip(p) {
    const hidden = !settings.openHands && !G.over;
    const fresh = G.lastMove && G.lastMove.player === p ? G.lastMove.drawn : null;
    const minis = G.hands[p].map(t => {
      if (!t) return '<span class="mini empty"></span>';
      if (hidden) return '<span class="mini back"></span>';
      return `<span class="mini${fresh && fresh.has(t.id) ? ' fresh' : ''}">${t.bit}</span>`;
    }).join('');
    return `<div class="strip p${p + 1}">
      <span class="st-name"><i class="dot"></i>${NAMES[p]}</span>
      <span class="minis">${minis}</span>
      <span class="flag on${claimLive(p) ? '' : ' off'}">I see a word</span>
    </div>`;
  }

  function pieceHTML(key, shape) {
    if (key === 'board') return renderBoard();
    if (key === 'strip') return renderStrip(1 - G.current);
    const p = key === 'me' ? G.current : +key.slice(1);
    return renderStation(p, shape);
  }

  // ---------- layout ----------

  // A piece whose rotated bounding box has its top-left at (x, y).
  function spec(key, shape, size, rot, x, y, scale = 1) {
    const quarter = Math.abs(rot) === 90;
    return { key, shape, size, rot, scale, x, y, bw: quarter ? size.h : size.w, bh: quarter ? size.w : size.h };
  }

  function boardFacing() {
    const geo = settings.geography;
    if (geo === 'side' || geo === 'handover') return [0, 1];
    const map = geo === 'across'
      ? { p1: [0, 1], p2: [180, 1], neutral: [90, 1] }
      : { p1: [0, 1], p2: [-90, 1], neutral: [-45, 0.72] };
    return map[settings.facing] || [0, 1];
  }

  // Each seating has a wide and a tall arrangement; render() keeps whichever fits the screen larger.
  // Both keep every station on its owner's side of the board. Row stations sit with their rack centred on the board.
  function arrangements(sizeOf) {
    const B = BOARD;
    const g = GAP;
    const col = p => sizeOf(`p${p}`, 'column');
    const row = p => sizeOf(`p${p}`, 'row');

    if (isMachine()) {
      const board = spec('board', null, { w: B, h: B }, 0, 0, 0, 1);
      const a = col(0);
      const ar = row(0);
      return [
        [board, spec('p0', 'row', ar, 0, B / 2 - ar.anchor, B + g)],
        [board, spec('p0', 'column', a, 0, (B - a.w) / 2, B + g)],
      ];
    }

    const [rot, sc] = boardFacing();
    const board = spec('board', null, { w: B, h: B }, rot, 0, 0, sc);

    switch (settings.geography) {
      case 'side': {
        const a = col(0);
        const b = col(1);
        const base = B + g + Math.max(a.h, b.h);
        return [
          [board, spec('p0', 'column', a, 0, -g - a.w, B - a.h), spec('p1', 'column', b, 0, B + g, B - b.h)],
          [board, spec('p0', 'column', a, 0, B / 2 - g / 2 - a.w, base - a.h), spec('p1', 'column', b, 0, B / 2 + g / 2, base - b.h)],
        ];
      }
      case 'across': {
        const a = col(0);
        const b = col(1);
        const ar = row(0);
        const br = row(1);
        return [
          [board, spec('p0', 'row', ar, 0, B / 2 - ar.anchor, B + g), spec('p1', 'row', br, 180, B / 2 - (br.w - br.anchor), -g - br.h)],
          [board, spec('p0', 'column', a, 0, (B - a.w) / 2, B + g), spec('p1', 'column', b, 180, (B - b.w) / 2, -g - b.h)],
        ];
      }
      case 'corner': {
        const a = col(0);
        const ar = row(0);
        const b = col(1);
        const p2 = spec('p1', 'column', b, -90, B + g, (B - b.w) / 2);
        return [
          [board, spec('p0', 'row', ar, 0, B / 2 - ar.anchor, B + g), p2],
          [board, spec('p0', 'column', a, 0, (B - a.w) / 2, B + g), p2],
        ];
      }
      default: {
        const me = sizeOf('me', 'column');
        const strip = sizeOf('strip', 'strip');
        return [
          [board, spec('strip', 'strip', strip, 0, (B - strip.w) / 2, -12 - strip.h), spec('me', 'column', me, 0, (B - me.w) / 2, B + 20)],
          [board, spec('me', 'column', me, 0, B + g, B - me.h), spec('strip', 'strip', strip, 0, B + g, B - me.h - 12 - strip.h)],
        ];
      }
    }
  }

  function availableSpace() {
    const narrow = window.innerWidth < 700;
    const padX = narrow ? 8 : 40;
    const top = narrow ? 46 : 54;
    const bottom = narrow ? 8 : 36;
    return { w: window.innerWidth - padX * 2, h: window.innerHeight - top - bottom, top };
  }

  function bounds(pieces) {
    const minX = Math.min(...pieces.map(p => p.x));
    const minY = Math.min(...pieces.map(p => p.y));
    const maxX = Math.max(...pieces.map(p => p.x + p.bw));
    const maxY = Math.max(...pieces.map(p => p.y + p.bh));
    return { minX, minY, w: maxX - minX, h: maxY - minY };
  }

  function render() {
    if (!G) return;
    const sizes = new Map();
    const sizeOf = (key, shape) => {
      const k = `${key}:${shape}`;
      if (!sizes.has(k)) {
        measure.innerHTML = pieceHTML(key, shape);
        const el = measure.firstElementChild;
        const rack = el.querySelector('.rack');
        const anchor = rack ? rack.offsetLeft - el.offsetLeft + rack.offsetWidth / 2 : el.offsetWidth / 2;
        sizes.set(k, { w: el.offsetWidth, h: el.offsetHeight, anchor });
        measure.innerHTML = '';
      }
      return sizes.get(k);
    };

    const avail = availableSpace();
    let best = null;
    for (const pieces of arrangements(sizeOf)) {
      const box = bounds(pieces);
      const scale = Math.min(avail.w / box.w, avail.h / box.h, 1.25);
      if (!best || scale > best.scale + 0.001) best = { pieces, box, scale };
    }

    const { pieces, box, scale } = best;
    table.innerHTML = pieces.map(pc => {
      const left = pc.x - box.minX + pc.bw / 2 - pc.size.w / 2;
      const top = pc.y - box.minY + pc.bh / 2 - pc.size.h / 2;
      return `<div class="piece" style="left:${left}px;top:${top}px;width:${pc.size.w}px;height:${pc.size.h}px;transform:rotate(${pc.rot}deg) scale(${pc.scale})">${pieceHTML(pc.key, pc.shape)}</div>`;
    }).join('');

    table.style.width = `${box.w}px`;
    table.style.height = `${box.h}px`;
    table.style.top = `${avail.top + avail.h / 2}px`;
    table.style.transform = `translate(-50%, -50%) scale(${scale})`;
    G.justPlaced = null;
    renderChrome();
  }

  function renderChrome() {
    chrome.innerHTML = `
      ${G && G.over ? '<button class="chrome-btn" data-action="record">Record</button>' : ''}
      <button class="chrome-btn" data-action="rules">Rules</button>
      <button class="chrome-btn" data-action="settings">Settings</button>
      <button class="chrome-btn" data-action="new">New game</button>`;
  }

  // ---------- overlays ----------

  function openOverlay(kind, html) {
    overlayKind = kind;
    overlay.className = kind === 'handoff' ? 'handoff' : '';
    overlay.innerHTML = `<div class="sheet ${kind}">${html}</div>`;
    overlay.hidden = false;
  }

  function closeOverlay() {
    overlayKind = null;
    overlay.hidden = true;
    overlay.className = '';
    overlay.innerHTML = '';
    maybeQueueMachine();
  }

  function showHandoff() {
    const p = G.current;
    openOverlay('handoff', `
      <div class="ho-name">${NAMES[p]}</div>
      <div class="ho-turn">Your turn</div>
      <button class="btn ho-btn" data-action="close">Start</button>`);
    overlay.dataset.player = p + 1;
  }

  function showRules(first = false) {
    const handover = settings.geography === 'handover' && !isMachine();
    openOverlay('rules', `
      <h1>Binary Scrabble</h1>
      <p class="sub">${isMachine()
        ? 'A collaborative game for one person and a machine. Neither of you speaks.'
        : 'A collaborative game for two people who may not speak.'}</p>

      <h3>The goal</h3>
      <p>Together, spell any word, reading top to bottom.
      Each row is one capital letter, written as eight bits of ASCII. The tiles are only 0s and 1s.</p>

      <h3>Each turn</h3>
      <ul>
        <li>Place 4 tiles from your rack, then draw back up to 8.</li>
        ${settings.placement === 'line' ? '<li>If your tiles fill the last gap in a row or column, you may stop there.</li>' : ''}
      </ul>

      <h3>Ending</h3>
      <p>If you think there’s a word anywhere on the board, press <b>I see a word</b> at any time — you don’t wait for a turn.
      ${isMachine()
        ? 'If the machine also sees a word, the game ends and the board is decoded. If it takes a turn instead, your claim drops.'
        : 'Your partner’s button then lights up. If they press theirs too, the game ends and the board is decoded. If they finish a turn instead, your claim drops.'}</p>

      <p class="hush-line">No talking.</p>

      <h3>On this screen</h3>
      <p>Tap a tile in your rack, then a square. Tap a placed tile to take it back.
      Your partner’s last move is outlined in their colour until you start placing.
      ${handover ? 'After each turn, hand the device over.' : 'Keys: <kbd>0</kbd> <kbd>1</kbd> pick a tile, <kbd>Enter</kbd> ends the turn, <kbd>⌫</kbd> undoes.'}</p>

      <div class="sheet-actions">
        <button class="btn" data-action="settings">Settings</button>
        <button class="btn primary" data-action="close">${first ? 'Begin' : 'Back'}</button>
      </div>
      <p class="byline">An art-game by <a href="https://andrewsheerin.art" target="_blank" rel="noopener">Andrew Sheerin</a></p>`);
  }

  function showSettings() {
    const rows = SETTING_GROUPS.map(g => {
      if (g.section) return `<h3>${g.section}</h3>`;
      const disabled = g.disabledWhen && g.disabledWhen(settings);
      const pills = g.options.map(([v, label]) =>
        `<button class="pill${settings[g.key] === v ? ' on' : ''}" data-action="set" data-key="${g.key}" data-value='${JSON.stringify(v)}' ${disabled ? 'disabled' : ''}>${label}</button>`
      ).join('');
      const noteText = g.note ? g.note(settings) : '';
      const note = noteText ? `<div class="set-note">${noteText}</div>` : '';
      return `<div class="set-row"><div class="set-label">${g.label}${note}</div><div class="pills">${pills}</div></div>`;
    }).join('');

    const total = settings.zeros + settings.ones;
    const bagChanged = G && !G.over && (settings.zeros !== G.bagSpec.zeros || settings.ones !== G.bagSpec.ones);
    const bag = `<h3>Bag</h3>
      <div class="set-row">
        <div class="set-label">Tiles in the bag
          <div class="set-note">Capital letters are about 59% zeros. ${total} tiles total; the board holds 64.</div>
          ${bagChanged ? '<div class="set-note warn">This takes effect from the next game.</div>' : ''}
        </div>
        <div class="num-group">
          0s <input class="num" type="number" min="0" max="300" data-num="zeros" value="${settings.zeros}">
          1s <input class="num" type="number" min="0" max="300" data-num="ones" value="${settings.ones}">
        </div>
      </div>`;

    openOverlay('settings', `
      <h2>Settings</h2>
      ${rows}
      ${bag}
      <div class="sheet-actions">
        <button class="btn" data-action="close">Close</button>
        <button class="btn primary" data-action="new">New game</button>
      </div>`);
  }

  function showRecord() {
    const { rows, runs } = readMessage();
    const dead = deadLetterRows();
    const marked = runs.map(run => {
      const live = liveOffsets(run.text, roomAfter(run.start + run.text.length - 1));
      return markRun(run.text, live);
    }).filter(Boolean);
    const spoken = runs.map(run => {
      const live = liveOffsets(run.text, roomAfter(run.start + run.text.length - 1));
      return [...run.text].filter((_, i) => live.has(i)).join('');
    }).filter(Boolean).join(' ');
    const word = marked.length ? marked.join(' ') : '—';
    const elapsed = formatDuration((G.endedAt || Date.now()) - G.startedAt);

    const rowHTML = rows.map((d, r) => {
      const bits = G.board[r].map(cell =>
        cell ? `<span class="mb by-p${cell.by + 1}">${cell.bit}</span>` : '<span class="mb empty"></span>'
      ).join('');
      const cls = [
        d ? (d.letter ? 'letter' : 'other') : 'incomplete',
        dead[r] ? 'dead' : '',
      ].filter(Boolean).join(' ');
      const ch = d ? (d.letter ? d.char : (d.char ?? '□')) : '·';
      return `<tr class="${cls}">
        <td class="rn">${r + 1}</td>
        <td><div class="bits">${bits}</div></td>
        <td class="val">${d ? `= ${d.value}` : ''}</td>
        <td class="ch">${ch}</td>
      </tr>`;
    }).join('');

    const epitaph = runs.length
      ? `It took ${elapsed} and ${G.stats.placed} tiles to say “${spoken || runs.map(r => r.text).join(' ')}”.`
      : `${elapsed}. ${G.stats.placed} tiles. No letters.`;

    openOverlay('record', `
      <div class="reason">${END_REASONS[G.over]}</div>
      <div class="word">${word}</div>
      <p class="epitaph">${epitaph}</p>
      <table>${rowHTML}</table>
      <div class="stats">
        <span><b>${G.turn}</b>turns</span>
        <span><b>${G.stats.placed}</b>tiles</span>
      </div>
      <div class="sheet-actions">
        <button class="btn" data-action="close">View board</button>
        <button class="btn primary" data-action="new">New game</button>
      </div>`);
  }

  // ---------- events ----------

  document.addEventListener('click', e => {
    if (overlayKind === 'handoff' && overlay.contains(e.target)) { closeOverlay(); return; }
    if (e.target === overlay && overlayKind !== 'rules') { closeOverlay(); return; }
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const d = el.dataset;

    switch (d.action) {
      case 'tile': onTile(+d.p, +d.id); break;
      case 'cell': onCell(+d.r, +d.c); break;
      case 'undo': undo(); break;
      case 'done': done(); break;
      case 'flag': toggleClaim(+d.p); break;
      case 'reftab': ui.refTab[+d.p] = d.tab; render(); break;
      case 'rules': showRules(); break;
      case 'settings': showSettings(); break;
      case 'record': if (G && G.over) showRecord(); break;
      case 'close': closeOverlay(); break;
      case 'new': closeOverlay(); newGame(); break;
      case 'set':
        settings[d.key] = JSON.parse(d.value);
        if (d.key === 'partner' && settings.partner === 'machine') settings.gravity = false;
        saveSettings();
        if (G && !G.over) beginTurn();
        render();
        showSettings();
        maybeQueueMachine();
        break;
    }
  });

  overlay.addEventListener('change', e => {
    const key = e.target.dataset.num;
    if (!key) return;
    settings[key] = Math.max(0, Math.min(300, Math.round(+e.target.value || 0)));
    saveSettings();
    showSettings();
  });

  table.addEventListener('pointerover', e => {
    table.querySelectorAll('.cell.target').forEach(el => el.classList.remove('target'));
    const cellEl = e.target.closest('.cell');
    if (!cellEl || !G || G.over || G.machineBusy || G.selected == null) return;
    const t = targetCell(+cellEl.dataset.r, +cellEl.dataset.c);
    if (!t || !placementAllowed(t.r, t.c)) return;
    table.querySelector(cellSel(t.r, t.c))?.classList.add('target');
  });

  table.addEventListener('pointerleave', () => {
    table.querySelectorAll('.cell.target').forEach(el => el.classList.remove('target'));
  });

  document.addEventListener('keydown', e => {
    if (!overlay.hidden) {
      if (e.key === 'Escape' || (overlayKind === 'handoff' && (e.key === 'Enter' || e.key === ' '))) closeOverlay();
      return;
    }
    if (!G || G.over || G.machineBusy) return;
    if (e.key === '0' || e.key === '1') selectBit(+e.key);
    else if (e.key === 'Enter') done();
    else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
    else if (e.key === 'Escape') { G.selected = null; render(); }
  });

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(render);
  });

  newGame();
  showRules(true);
})();
