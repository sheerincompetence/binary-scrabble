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
  const STORAGE_KEY = 'binary-scrabble/settings/v1';
  const LAST_FADE_MS = 900;

  const isSmallScreen = () => Math.min(window.innerWidth, window.innerHeight) < 600;

  const DEFAULT_SETTINGS = {
    geography: isSmallScreen() ? 'handover' : 'across',
    facing: 'p1',
    placement: 'line',
    gravity: false,
    openHands: true,
    boardValues: false,
    reveal: false,
    zeros: 60,
    ones: 40,
  };

  const SEATING_NOTES = {
    side: 'Shoulder to shoulder. You share one point of view.',
    across: 'Opposite each other. Whoever the board doesn’t face reads it upside down: rows bottom-up, every byte backwards.',
    corner: 'At a corner. One of you reads the board sideways, so rows look like columns.',
    handover: 'One device, passed between you after every turn. Whoever holds it gets the upright view.',
  };

  const SETTING_GROUPS = [
    { section: 'Table' },
    {
      key: 'geography', label: 'Seating',
      options: [['side', 'Side by side'], ['across', 'Across'], ['corner', 'Corner'], ['handover', 'Hand it over']],
      note: s => SEATING_NOTES[s.geography],
    },
    {
      key: 'facing', label: 'Board faces',
      options: [['p1', 'Player 1'], ['p2', 'Player 2'], ['neutral', 'Neither']],
      disabledWhen: s => s.geography === 'side' || s.geography === 'handover',
      note: s => s.facing === 'neutral' && s.geography !== 'side' && s.geography !== 'handover' ? 'Nobody gets the upright view.' : '',
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
      note: s => s.gravity ? 'Connect-Four style. The word still reads top-down, so the last letter gets built first.' : '',
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
      current: 0,
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
    };
    refill(0);
    refill(1);
    beginTurn();
    render();
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
    G.required = Math.min(PER_TURN, handCount(G.current), emptyCount());
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
    rows.forEach(d => {
      if (d && d.letter) cur += d.char;
      else { if (cur) runs.push(cur); cur = ''; }
    });
    if (cur) runs.push(cur);
    return { rows, runs };
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
    if (G.over) return;
    if (p !== G.current) { shake(`.slot[data-id="${id}"]`); return; }
    G.selected = G.selected === id ? null : id;
    render();
  }

  function onCell(r, c) {
    if (G.over) return;
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
    if (G.over || !G.pending.length) return;
    const { r, c } = G.pending[G.pending.length - 1];
    takeBack(r, c);
  }

  function commitPending() {
    G.pending.forEach(({ r, c }) => { G.board[r][c].pending = false; });
    G.stats.placed += G.pending.length;
    G.pending = [];
  }

  function done() {
    if (G.over) return;
    if (!canEndTurn()) { shake('.station.active .rack'); return; }
    const cells = G.pending.map(({ r, c }) => `${r},${c}`);
    commitPending();
    finishTurn(cells, refill(G.current));
  }

  function toggleClaim(p) {
    if (G.over) return;
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
    if (handCount(next) === 0) next = p;
    if (handCount(next) === 0) { endGame('dry'); return; }

    G.current = next;
    G.turn++;
    beginTurn();
    render();
    if (settings.geography === 'handover') showHandoff();
  }

  function endGame(reason) {
    commitPending();
    G.over = reason;
    G.endedAt = Date.now();
    G.selected = null;
    render();
    showRecord();
  }

  function selectBit(bit) {
    if (G.over) return;
    const hand = G.hands[G.current];
    const idx = hand.map((t, i) => (t && t.bit === bit ? i : -1)).filter(i => i >= 0);
    if (!idx.length) return;
    const cur = hand.findIndex(t => t && t.id === G.selected);
    const next = idx.find(i => i > cur) ?? idx[0];
    G.selected = hand[next].id;
    render();
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

    const decode = settings.reveal
      ? `<div class="edge decode">${range(ROWS).map(r => {
          const d = decodeRow(r);
          if (!d) return '<span></span>';
          return d.letter ? `<span>${d.char}</span>` : `<span class="other">${d.char ?? d.value}</span>`;
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

    const status = G.over ? '' : active ? 'Your turn' : `${NAMES[G.current]} turn`;

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
    const [rot, sc] = boardFacing();
    const board = spec('board', null, { w: B, h: B }, rot, 0, 0, sc);
    const col = p => sizeOf(`p${p}`, 'column');
    const row = p => sizeOf(`p${p}`, 'row');

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
    const handover = settings.geography === 'handover';
    openOverlay('rules', `
      <h1>Binary Scrabble</h1>
      <p class="sub">A collaborative game for two people who may not speak.</p>

      <h3>The goal</h3>
      <p>Together, spell any word, reading from the top of the board down.
      Each row is one capital letter, written as eight bits of ASCII. The tiles are only 0s and 1s.</p>

      <h3>Each turn</h3>
      <ul>
        <li>Place 4 tiles from your rack, then draw back up to 8.</li>
        ${settings.placement === 'line' ? '<li>If your tiles fill the last gap in a row or column, you may stop there.</li>' : ''}
      </ul>

      <h3>Ending</h3>
      <p>If you think there’s a word on the board, press <b>I see a word</b> at any time — you don’t wait for a turn.
      Your partner’s button then lights up. If they press theirs too, the game ends and the board is decoded. If they finish a turn instead, your claim drops.</p>

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
      <p class="sub">Table and rule changes apply right away.</p>
      ${rows}
      ${bag}
      <div class="sheet-actions">
        <button class="btn" data-action="close">Close</button>
        <button class="btn primary" data-action="new">New game</button>
      </div>`);
  }

  function showRecord() {
    const { rows, runs } = readMessage();
    const word = runs.length ? runs.join(' ') : '—';
    const elapsed = formatDuration((G.endedAt || Date.now()) - G.startedAt);

    const rowHTML = rows.map((d, r) => {
      const bits = G.board[r].map(cell =>
        cell ? `<span class="mb by-p${cell.by + 1}">${cell.bit}</span>` : '<span class="mb empty"></span>'
      ).join('');
      const cls = d ? (d.letter ? 'letter' : 'other') : 'incomplete';
      const ch = d ? (d.letter ? d.char : (d.char ?? '□')) : '·';
      return `<tr class="${cls}">
        <td class="rn">${r + 1}</td>
        <td><div class="bits">${bits}</div></td>
        <td class="val">${d ? `= ${d.value}` : ''}</td>
        <td class="ch">${ch}</td>
      </tr>`;
    }).join('');

    const epitaph = runs.length
      ? `It took ${elapsed} and ${G.stats.placed} tiles to say “${word}”.`
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
        saveSettings();
        if (G && !G.over) beginTurn();
        render();
        showSettings();
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
    if (!cellEl || !G || G.over || G.selected == null) return;
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
    if (!G || G.over) return;
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
