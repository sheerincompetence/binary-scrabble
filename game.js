(() => {
  'use strict';

  const ROWS = 8;
  const COLS = 8;
  const HAND_SIZE = 8;
  const PER_TURN = 4;
  const MAX_STACK = 3;
  const PLACE_VALUES = [128, 64, 32, 16, 8, 4, 2, 1];
  const EXAMPLE_BITS = [0, 0, 1, 0, 1, 0, 1, 0];
  const NAMES = ['Player 1', 'Player 2'];
  const STORAGE_KEY = 'binary-scrabble/settings/v1';

  const DEFAULT_SETTINGS = {
    geography: 'across',
    facing: 'p1',
    placement: 'line',
    stacking: false,
    gravity: false,
    openHands: true,
    allowSwap: true,
    refBinary: false,
    boardValues: false,
    reveal: false,
    zeros: 60,
    ones: 40,
  };

  // Natural (unrotated) sizes in table pixels.
  const SIZES = { wide: [1000, 210], stacked: [490, 432], board: [520, 520] };

  // Each piece is positioned by its centre, then rotated to face its owner.
  const LAYOUTS = {
    side: {
      w: 1580, h: 520,
      board: { x: 790, y: 260 },
      stations: [
        { kind: 'stacked', x: 245, y: 260, rot: 0 },
        { kind: 'stacked', x: 1335, y: 260, rot: 0 },
      ],
      facing: { p1: [0, 1], p2: [0, 1], neutral: [0, 1] },
    },
    across: {
      w: 1000, h: 1000,
      board: { x: 500, y: 500 },
      stations: [
        { kind: 'wide', x: 500, y: 895, rot: 0 },
        { kind: 'wide', x: 500, y: 105, rot: 180 },
      ],
      facing: { p1: [0, 1], p2: [180, 1], neutral: [90, 1] },
    },
    corner: {
      w: 1000, h: 760,
      board: { x: 278, y: 260 },
      stations: [
        { kind: 'wide', x: 500, y: 655, rot: 0 },
        { kind: 'stacked', x: 784, y: 260, rot: -90 },
      ],
      facing: { p1: [0, 1], p2: [-90, 1], neutral: [-45, 0.72] },
    },
  };

  const SETTING_GROUPS = [
    { section: 'Table' },
    {
      key: 'geography', label: 'Seating',
      options: [['side', 'Side by side'], ['across', 'Across'], ['corner', 'Corner']],
      note: s => ({
        side: 'Shoulder to shoulder. You share one point of view.',
        across: 'Opposite each other. Whoever the board doesn’t face reads it upside down: rows bottom-up, every byte backwards.',
        corner: 'At a corner. One of you reads the board sideways, so rows look like columns.',
      })[s.geography],
    },
    {
      key: 'facing', label: 'Board faces',
      options: [['p1', 'Player 1'], ['p2', 'Player 2'], ['neutral', 'Neither']],
      disabledWhen: s => s.geography === 'side',
      note: s => s.geography === 'side' ? 'Side by side, the board faces you both.' : (s.facing === 'neutral' ? 'Nobody gets the upright view.' : ''),
    },
    { section: 'Rules' },
    {
      key: 'placement', label: 'A turn’s 4 tiles go',
      options: [['row', 'In one row'], ['line', 'One row or column'], ['free', 'Anywhere']],
    },
    {
      key: 'stacking', label: 'Stacking',
      options: [[false, 'Off'], [true, `Up to ${MAX_STACK} high`]],
      note: s => s.stacking ? 'Place on top of any tile from an earlier turn. Only the top tile counts: cover a bit to change it, or match it to agree. Filling the last gaps in a row or column lets you stop with fewer than 4.' : '',
    },
    {
      key: 'gravity', label: 'Tiles slide to the bottom',
      options: [[false, 'Off'], [true, 'On']],
      note: s => s.gravity ? 'Connect-Four style. The word still reads top-down, so the last letter gets built first.' : '',
    },
    { key: 'openHands', label: 'Racks', options: [[true, 'Open'], [false, 'Hidden']] },
    { key: 'allowSwap', label: 'Swap tiles instead of placing', options: [[true, 'Allowed'], [false, 'No']] },
    { section: 'Help' },
    { key: 'refBinary', label: 'ASCII card shows', options: [[false, 'Decimal'], [true, 'Decimal + binary']] },
    { key: 'boardValues', label: 'Column values on board', options: [[false, 'Hidden'], [true, 'Shown']] },
    { key: 'reveal', label: 'Decode rows on board', options: [[false, 'Off'], [true, 'On (cheat)']] },
  ];

  const END_REASONS = {
    agreed: 'You both saw a word',
    full: 'The board is full',
    capped: 'Every stack is at its cap',
    dry: 'The tiles ran out',
    stuck: 'Neither of you could move',
  };

  const table = document.getElementById('table');
  const overlay = document.getElementById('overlay');
  const chrome = document.getElementById('chrome');

  let settings = loadSettings();
  let G = null;
  let noticeTimer = null;
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
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
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
      board: range(ROWS).map(() => range(COLS).map(() => [])),
      bag,
      hands: [Array(HAND_SIZE).fill(null), Array(HAND_SIZE).fill(null)],
      current: 0,
      pending: [],
      selected: null,
      swapping: false,
      swapSel: new Set(),
      wordFlags: [false, false],
      turn: 1,
      required: PER_TURN,
      passStreak: 0,
      stats: { placed: 0, swaps: 0, passes: 0, corrections: 0, confirmations: 0 },
      startedAt: Date.now(),
      endedAt: null,
      over: null,
      notice: null,
      justPlaced: null,
    };
    refill(0);
    refill(1);
    beginTurn();
    render();
  }

  const handCount = p => G.hands[p].filter(Boolean).length;
  const topAt = (r, c) => G.board[r][c][G.board[r][c].length - 1] || null;

  // Can a tile go on this square at all (ignoring gravity and this turn's line)?
  function hasRoom(r, c) {
    const top = topAt(r, c);
    if (!top) return true;
    return settings.stacking && !top.pending && G.board[r][c].length < MAX_STACK;
  }

  function spotsLeft() {
    let n = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (hasRoom(r, c)) n++;
    return n;
  }

  function refill(p) {
    const hand = G.hands[p];
    for (let i = 0; i < HAND_SIZE && G.bag.length; i++) {
      if (!hand[i]) hand[i] = G.bag.pop();
    }
  }

  function beginTurn() {
    G.required = Math.min(PER_TURN, handCount(G.current), spotsLeft());
  }

  // Where a tile aimed at (r, c) would actually land.
  function targetCell(r, c) {
    if (G.board[r][c].length) return hasRoom(r, c) ? { r, c } : null;
    if (!settings.gravity) return { r, c };
    for (let rr = ROWS - 1; rr >= 0; rr--) {
      if (!G.board[rr][c].length) return { r: rr, c };
    }
    return null;
  }

  function placementAllowed(r, c) {
    const p = G.pending;
    if (p.length >= G.required) return `That’s ${G.required}. Press Done.`;
    if (settings.placement === 'free' || p.length === 0) return true;
    const sameRow = p.every(t => t.r === r);
    const sameCol = p.every(t => t.c === c);
    if (settings.placement === 'row') return sameRow || 'This turn’s tiles must share a row.';
    return sameRow || sameCol || 'This turn’s tiles must share a row or a column.';
  }

  function isLanding(r, c) {
    const t = targetCell(r, c);
    return !!t && t.r === r && t.c === c && placementAllowed(r, c) === true;
  }

  function canPlaceMore() {
    if (G.pending.length >= G.required || handCount(G.current) === 0) return false;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) if (isLanding(r, c)) return true;
    }
    return false;
  }

  function canSwap() {
    return settings.allowSwap && !G.over && G.pending.length === 0 && G.bag.length > 0;
  }

  // 'row' or 'column' if this turn's tiles just filled the last empty squares of one.
  function completedLine() {
    const p = G.pending;
    if (!p.length) return null;
    const lines = [];
    if (p.every(t => t.r === p[0].r)) lines.push(['row', range(COLS).map(c => [p[0].r, c])]);
    if (p.every(t => t.c === p[0].c)) lines.push(['column', range(ROWS).map(r => [r, p[0].c])]);
    const done = lines.find(([, cells]) =>
      cells.every(([r, c]) => G.board[r][c].length) &&
      cells.some(([r, c]) => G.board[r][c].length === 1 && G.board[r][c][0].pending)
    );
    return done ? done[0] : null;
  }

  function doneState() {
    const n = G.pending.length;
    const early = settings.stacking && n > 0 && n < G.required ? completedLine() : null;
    return { ready: n >= G.required || !canPlaceMore() || !!early, early, label: n === 0 ? 'Pass' : 'Done' };
  }

  function decodeRow(r) {
    const tops = range(COLS).map(c => topAt(r, c));
    if (tops.some(x => !x)) return null;
    const value = tops.reduce((acc, x) => acc * 2 + x.bit, 0);
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

  function notify(text) {
    G.notice = text;
    render();
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { if (G) { G.notice = null; render(); } }, 2200);
  }

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
    if (G.swapping) {
      G.swapSel.has(id) ? G.swapSel.delete(id) : G.swapSel.add(id);
    } else {
      G.selected = G.selected === id ? null : id;
    }
    render();
  }

  function onCell(r, c) {
    if (G.over || G.swapping) return;
    const top = topAt(r, c);
    if (top && top.pending) { takeBack(r, c); return; }

    const p = G.current;
    const slot = G.hands[p].findIndex(t => t && t.id === G.selected);
    if (slot < 0) {
      if (!top || settings.stacking) notify('Pick a tile from your rack first.');
      shake(cellSel(r, c));
      return;
    }
    const target = targetCell(r, c);
    if (!target) {
      if (top && settings.stacking) notify(`Stacks go ${MAX_STACK} high.`);
      shake(cellSel(r, c));
      return;
    }
    const verdict = placementAllowed(target.r, target.c);
    if (verdict !== true) { notify(verdict); shake(cellSel(r, c)); return; }

    const tile = G.hands[p][slot];
    G.hands[p][slot] = null;
    G.board[target.r][target.c].push({ bit: tile.bit, by: p, pending: true, tile, slot });
    G.pending.push({ r: target.r, c: target.c });
    G.selected = null;
    G.justPlaced = `${target.r},${target.c}`;
    render();
  }

  function takeBack(r, c) {
    const stack = G.board[r][c];
    if (settings.gravity && stack.length === 1 && r > 0 && G.board[r - 1][c].length) {
      notify('Take the tile above it back first.');
      shake(cellSel(r, c));
      return;
    }
    const cell = stack.pop();
    const hand = G.hands[G.current];
    const slot = hand[cell.slot] ? hand.indexOf(null) : cell.slot;
    hand[slot] = cell.tile;
    G.pending = G.pending.filter(t => !(t.r === r && t.c === c));
    G.selected = null;
    render();
  }

  function undo() {
    if (G.over || !G.pending.length) return;
    const { r, c } = G.pending[G.pending.length - 1];
    takeBack(r, c);
  }

  function done() {
    if (G.over || G.swapping) return;
    const { ready } = doneState();
    if (!ready) {
      notify(`Place ${G.required - G.pending.length} more.`);
      return;
    }
    endTurn(G.pending.length ? 'place' : 'pass');
  }

  function startSwap() {
    if (!canSwap()) return;
    G.swapping = true;
    G.selected = null;
    G.swapSel.clear();
    render();
  }

  function cancelSwap() {
    G.swapping = false;
    G.swapSel.clear();
    render();
  }

  function confirmSwap() {
    const p = G.current;
    const hand = G.hands[p];
    const out = [];
    hand.forEach((t, i) => {
      if (t && G.swapSel.has(t.id)) { out.push(t); hand[i] = null; }
    });
    if (!out.length || out.length > G.bag.length) return;
    refill(p);
    G.bag.push(...out);
    shuffle(G.bag);
    endTurn('swap');
  }

  function toggleFlag(p) {
    if (G.over) return;
    G.wordFlags[p] = !G.wordFlags[p];
    if (G.wordFlags[0] && G.wordFlags[1]) { endGame('agreed'); return; }
    render();
  }

  function commitPending() {
    G.pending.forEach(({ r, c }) => {
      const stack = G.board[r][c];
      const top = stack[stack.length - 1];
      const below = stack[stack.length - 2];
      if (below) below.bit === top.bit ? G.stats.confirmations++ : G.stats.corrections++;
      top.pending = false;
    });
    G.stats.placed += G.pending.length;
    G.pending = [];
  }

  function endTurn(kind) {
    const p = G.current;
    if (kind === 'place') {
      commitPending();
      G.passStreak = 0;
      // A raised flag was a claim about the old board.
      G.wordFlags = [false, false];
    } else if (kind === 'pass') {
      G.stats.passes++;
      G.passStreak++;
    } else if (kind === 'swap') {
      G.stats.swaps++;
      G.passStreak = 0;
    }
    refill(p);
    G.selected = null;
    G.swapping = false;
    G.swapSel.clear();
    G.notice = null;

    if (spotsLeft() === 0) { endGame(settings.stacking ? 'capped' : 'full'); return; }
    if (handCount(0) === 0 && handCount(1) === 0) { endGame('dry'); return; }
    if (G.passStreak >= 2) { endGame('stuck'); return; }

    G.current = 1 - p;
    G.turn++;
    beginTurn();
    render();
  }

  function endGame(reason) {
    commitPending();
    G.over = reason;
    G.endedAt = Date.now();
    G.selected = null;
    G.swapping = false;
    G.notice = null;
    render();
    showRecord();
  }

  function selectBit(bit) {
    if (G.over || G.swapping) return;
    const hand = G.hands[G.current];
    const idx = hand.map((t, i) => (t && t.bit === bit ? i : -1)).filter(i => i >= 0);
    if (!idx.length) return;
    const cur = hand.findIndex(t => t && t.id === G.selected);
    const next = idx.find(i => i > cur) ?? idx[0];
    G.selected = hand[next].id;
    render();
  }

  // ---------- rendering ----------

  function placeStyle(cx, cy, w, h, rot, scale = 1) {
    return `left:${cx - w / 2}px;top:${cy - h / 2}px;width:${w}px;height:${h}px;transform:rotate(${rot}deg) scale(${scale});`;
  }

  function fit() {
    const L = LAYOUTS[settings.geography];
    const pad = 44;
    const s = Math.min((window.innerWidth - pad * 2) / L.w, (window.innerHeight - pad * 2) / L.h);
    table.style.width = `${L.w}px`;
    table.style.height = `${L.h}px`;
    table.style.transform = `translate(-50%, -50%) scale(${s})`;
  }

  function tileHTML(bit, o = {}) {
    if (o.back) return '<span class="tile back"></span>';
    const cls = ['tile'];
    if (o.by != null) cls.push(`by-p${o.by + 1}`);
    if (o.pending) cls.push('pending');
    if (o.selected) cls.push('selected');
    if (o.swap) cls.push('swap');
    if (o.drop) cls.push('drop');
    const height = o.layers && o.layers.length > 1
      ? `<span class="hp">${o.layers.map(by => `<i class="by-p${by + 1}"></i>`).join('')}</span>`
      : '';
    return `<span class="${cls.join(' ')}">${height}<span class="digit">${bit}</span><span class="pv">${bit}</span></span>`;
  }

  function renderBoard() {
    const choosing = !G.over && !G.swapping && G.selected != null;
    const cells = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const stack = G.board[r][c];
        const open = choosing && isLanding(r, c);
        const inner = stack.length
          ? `<span class="stack h${stack.length}">${stack.map((t, i) => tileHTML(t.bit, {
              by: t.by,
              pending: t.pending,
              drop: i === stack.length - 1 && G.justPlaced === `${r},${c}`,
              layers: i === stack.length - 1 ? stack.map(s => s.by) : null,
            })).join('')}</span>`
          : '';
        cells.push(`<button class="cell${open ? ' open' : ''}" data-action="cell" data-r="${r}" data-c="${c}" aria-label="Row ${r + 1}, column ${c + 1}">${inner}</button>`);
      }
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
      <div class="grid">${cells.join('')}</div>
      ${decode}
      <div class="board-foot"><span>Turn ${G.turn}</span><span>Bag ${G.bag.length}</span></div>
    </div>`;
  }

  function renderRefs() {
    const values = PLACE_VALUES.map((v, i) => `<span class="v${EXAMPLE_BITS[i] ? ' hit' : ''}">${v}</span>`).join('');
    const bits = EXAMPLE_BITS.map(b => `<span class="b${b ? ' one' : ''}">${b}</span>`).join('');
    const binary = `<div class="card card-binary">
      <h4>Binary</h4>
      <p>Read a row left to right. Each column has a value.</p>
      <div class="bits-grid">${values}${bits}</div>
      <p>Add the values above every 1.</p>
      <div class="sum">32 + 8 + 2 = 42</div>
    </div>`;

    const entries = [];
    for (let v = 65; v <= 90; v++) {
      const bin = settings.refBinary ? `<i>${v.toString(2).padStart(8, '0')}</i>` : '';
      entries.push(`<span class="e"><b>${v}</b>${bin}<em>${String.fromCharCode(v)}</em></span>`);
    }
    const ascii = `<div class="card card-ascii${settings.refBinary ? ' with-bin' : ''}">
      <h4>ASCII · Capitals</h4>
      <div class="ascii-grid">${entries.join('')}</div>
    </div>`;

    return `<div class="refs">${binary}${ascii}</div>`;
  }

  function renderStation(p, kind) {
    const active = !G.over && G.current === p;
    const hidden = !settings.openHands && !active && !G.over;

    const slots = G.hands[p].map(t => {
      if (!t) return '<span class="slot empty"></span>';
      const sel = active && (G.swapping ? G.swapSel.has(t.id) : G.selected === t.id);
      const tile = tileHTML(t.bit, { back: hidden, selected: sel && !G.swapping, swap: sel && G.swapping });
      return `<button class="slot" data-action="tile" data-p="${p}" data-id="${t.id}">${tile}</button>`;
    }).join('');

    let status = '';
    if (!G.over) {
      if (!active) status = '<span class="st-status">Waiting</span>';
      else if (G.notice) status = `<span class="st-status notice">${G.notice}</span>`;
      else if (G.swapping) status = '<span class="st-status">Pick tiles to swap</span>';
      else {
        const pips = range(G.required).map(i => `<i class="pip${i < G.pending.length ? ' on' : ''}"></i>`).join('');
        const { early } = doneState();
        status = early
          ? `<span class="st-status"><span class="pips">${pips}</span> ${early} filled · you may stop</span>`
          : `<span class="st-status">Your turn <span class="pips">${pips}</span></span>`;
      }
    }

    let actions = '';
    if (active && G.swapping) {
      const n = G.swapSel.size;
      actions = `<button class="btn" data-action="swap-cancel">Cancel</button>
        <button class="btn primary" data-action="swap-confirm" ${n && n <= G.bag.length ? '' : 'disabled'}>Swap ${n || ''}</button>`;
    } else if (active) {
      const { ready, label } = doneState();
      actions = `<button class="btn" data-action="undo" ${G.pending.length ? '' : 'disabled'}>Undo</button>
        ${settings.allowSwap ? `<button class="btn" data-action="swap" ${canSwap() ? '' : 'disabled'}>Swap</button>` : ''}
        <button class="btn primary" data-action="done" ${ready ? '' : 'disabled'}>${label}</button>`;
    }

    const flag = `<button class="flag${G.wordFlags[p] ? ' on' : ''}" data-action="flag" data-p="${p}" ${G.over ? 'disabled' : ''}>I see a word</button>`;

    return `<section class="station ${kind} p${p + 1}${active ? ' active' : ''}">
      <div class="rack-col">
        <header class="st-head">
          <span class="st-name"><i class="dot"></i>${NAMES[p]}</span>
          ${status}
          ${flag}
        </header>
        <div class="rack">${slots}</div>
        <div class="st-actions">${actions}</div>
      </div>
      ${renderRefs()}
    </section>`;
  }

  function renderChrome() {
    chrome.innerHTML = `
      ${G && G.over ? '<button class="chrome-btn" data-action="record">Record</button>' : ''}
      <button class="chrome-btn" data-action="rules">Rules</button>
      <button class="chrome-btn" data-action="settings">Settings</button>
      <button class="chrome-btn" data-action="new">New game</button>`;
  }

  function render() {
    if (!G) return;
    const L = LAYOUTS[settings.geography];
    const [rot, scale] = L.facing[settings.facing];
    const [bw, bh] = SIZES.board;

    let html = `<div class="board-wrap" style="${placeStyle(L.board.x, L.board.y, bw, bh, rot, scale)}">${renderBoard()}</div>`;
    L.stations.forEach((st, p) => {
      const [w, h] = SIZES[st.kind];
      html += `<div class="station-wrap" style="${placeStyle(st.x, st.y, w, h, st.rot)}">${renderStation(p, st.kind)}</div>`;
    });

    table.innerHTML = html;
    G.justPlaced = null;
    fit();
    renderChrome();
  }

  // ---------- overlays ----------

  function openOverlay(kind, html) {
    overlayKind = kind;
    overlay.innerHTML = `<div class="sheet ${kind}">${html}</div>`;
    overlay.hidden = false;
  }

  function closeOverlay() {
    overlayKind = null;
    overlay.hidden = true;
    overlay.innerHTML = '';
  }

  function showRules(first = false) {
    openOverlay('rules', `
      <h1>Binary Scrabble</h1>
      <p class="sub">A collaborative game for two people who may not speak.</p>

      <h3>The goal</h3>
      <p>Together, spell any word, reading from the top of the board down.
      Each row is one capital letter, written as eight bits of ASCII. The tiles are only 0s and 1s.</p>

      <h3>Each turn</h3>
      <ul>
        <li>Place 4 tiles from your rack.</li>
        ${settings.stacking ? `<li>You may place on top of tiles from earlier turns, up to ${MAX_STACK} high. Only the top tile counts.</li>
        <li>If your tiles fill the last gaps in a row or column, you may stop there, even with fewer than 4.</li>` : ''}
        <li>Draw back up to 8.</li>
        <li>You may swap tiles with the bag instead of placing.</li>
      </ul>

      <h3>Ending</h3>
      <p>When you think a word is on the board, press <b>I see a word</b>.
      If your partner presses theirs too, the game ends and the board is decoded.
      Flags drop whenever new tiles are placed.</p>

      <p class="hush-line">No talking.</p>

      <h3>On this screen</h3>
      <p>Tap a tile in your rack, then a square. Tap a placed tile to take it back.
      Keys: <kbd>0</kbd> <kbd>1</kbd> pick a tile, <kbd>Enter</kbd> ends the turn, <kbd>⌫</kbd> undoes.
      On a tablet, lay it flat between you and choose <i>Across</i> or <i>Corner</i> seating.</p>

      <div class="sheet-actions">
        <button class="btn" data-action="settings">Settings</button>
        <button class="btn primary" data-action="close">${first ? 'Begin' : 'Back to the table'}</button>
      </div>`);
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
    const bag = `<h3>Bag · next game</h3>
      <div class="set-row">
        <div class="set-label">Tiles in the bag
          <div class="set-note">Capital letters are about 59% zeros. ${total} tiles total; the board holds 64.</div>
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
      const bits = G.board[r].map(stack => {
        const top = stack[stack.length - 1];
        if (!top) return '<span class="mb empty"></span>';
        const h = stack.length > 1 ? `<span class="mh">${stack.length}</span>` : '';
        return `<span class="mb by-p${top.by + 1}">${top.bit}${h}</span>`;
      }).join('');
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
        <span><b>${G.stats.swaps}</b>swaps</span>
        <span><b>${G.stats.passes}</b>passes</span>
        ${G.stats.corrections + G.stats.confirmations ? `
          <span><b>${G.stats.corrections}</b>corrections</span>
          <span><b>${G.stats.confirmations}</b>confirmations</span>` : ''}
      </div>
      <div class="sheet-actions">
        <button class="btn" data-action="close">View board</button>
        <button class="btn primary" data-action="new">New game</button>
      </div>`);
  }

  // ---------- events ----------

  document.addEventListener('click', e => {
    if (e.target === overlay && overlayKind !== 'rules') { closeOverlay(); return; }
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const d = el.dataset;

    switch (d.action) {
      case 'tile': onTile(+d.p, +d.id); break;
      case 'cell': onCell(+d.r, +d.c); break;
      case 'undo': undo(); break;
      case 'done': done(); break;
      case 'swap': startSwap(); break;
      case 'swap-cancel': cancelSwap(); break;
      case 'swap-confirm': confirmSwap(); break;
      case 'flag': toggleFlag(+d.p); break;
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
    const n = Math.max(0, Math.min(300, Math.round(+e.target.value || 0)));
    settings[key] = n;
    saveSettings();
    showSettings();
  });

  table.addEventListener('pointerover', e => {
    table.querySelectorAll('.cell.target').forEach(el => el.classList.remove('target'));
    const cellEl = e.target.closest('.cell');
    if (!cellEl || !G || G.over || G.swapping || G.selected == null) return;
    const t = targetCell(+cellEl.dataset.r, +cellEl.dataset.c);
    if (!t || placementAllowed(t.r, t.c) !== true) return;
    table.querySelector(cellSel(t.r, t.c))?.classList.add('target');
  });

  table.addEventListener('pointerleave', () => {
    table.querySelectorAll('.cell.target').forEach(el => el.classList.remove('target'));
  });

  document.addEventListener('keydown', e => {
    if (!overlay.hidden) {
      if (e.key === 'Escape') closeOverlay();
      return;
    }
    if (!G || G.over) return;
    if (e.key === '0' || e.key === '1') selectBit(+e.key);
    else if (e.key === 'Enter') done();
    else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
    else if (e.key === 'Escape') { G.selected = null; G.swapping = false; G.swapSel.clear(); render(); }
  });

  window.addEventListener('resize', fit);

  newGame();
  showRules(true);
})();
