// Equity calculator: 2-6 players (hands or ranges), optional board and dead cards.
import { parseCards } from '../../engine/cards.js';
import { parseRange, rangeToString, rangeCombos } from '../../engine/ranges.js';
import { openRangeDialog } from '../range-dialog.js';
import { createDecisionPanel } from '../decision-panel.js';
import { el, pct } from '../dom.js';
import { runEquity, cancelEquity } from '../../workers/client.js';
import { load, save } from '../../storage/store.js';

const STORAGE_KEY = 'equityTab';
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const DEFAULT_STATE = {
  players: ['AsKs', 'TT+, AQs+, AKo'],
  board: '',
  dead: '',
  method: 'auto',
  iterations: 200000,
};

/** Classifies a player input: a 2-card hand, a range, empty, or an error. */
export function classifyInput(text) {
  const t = text.trim();
  if (!t) return { kind: 'empty' };
  try {
    const cards = parseCards(t);
    if (cards.length === 2) return { kind: 'hand', cards };
  } catch {
    // not a hand; try range notation below
  }
  try {
    const range = parseRange(t);
    const combos = rangeCombos(range);
    if (combos <= 0) return { kind: 'error', message: 'Range is empty' };
    return { kind: 'range', range, combos };
  } catch (err) {
    return { kind: 'error', message: err.message };
  }
}

function boardError(text) {
  try {
    const n = parseCards(text).length;
    if (![0, 3, 4, 5].includes(n)) return `Board needs 0, 3, 4 or 5 cards (got ${n})`;
    return '';
  } catch (err) {
    return err.message;
  }
}

export function renderEquityTab(root) {
  const saved = load(STORAGE_KEY, null);
  const state = { ...DEFAULT_STATE, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (!Array.isArray(state.players) || state.players.length < MIN_PLAYERS) state.players = [...DEFAULT_STATE.players];
  state.players = state.players.slice(0, MAX_PLAYERS).map(String);
  const persist = () => save(STORAGE_KEY, state);

  const rowsEl = el('div', { class: 'eq-rows' });
  const addBtn = el('button', { type: 'button', class: 'eq-add', text: '+ Add player' });
  const boardInput = el('input', { class: 'eq-board', placeholder: 'e.g. Qh7s2s', value: state.board, spellcheck: false });
  const deadInput = el('input', { class: 'eq-dead', placeholder: 'optional', value: state.dead, spellcheck: false });
  const boardMsg = el('div', { class: 'eq-msg' });
  const deadMsg = el('div', { class: 'eq-msg' });
  const methodSelect = el('select', { 'aria-label': 'Method' }, [
    el('option', { value: 'auto', text: 'Auto' }),
    el('option', { value: 'exact', text: 'Exact' }),
    el('option', { value: 'montecarlo', text: 'Monte Carlo' }),
  ]);
  methodSelect.value = state.method;
  const itersInput = el('input', {
    type: 'number',
    min: 1000,
    max: 10000000,
    step: 50000,
    value: state.iterations,
    'aria-label': 'Monte Carlo trials',
  });
  const calcBtn = el('button', { type: 'button', class: 'primary', text: 'Calculate' });
  const cancelBtn = el('button', { type: 'button', text: 'Cancel', disabled: true });
  const status = el('p', { class: 'eq-status', 'aria-live': 'polite' });

  const section = el('section', { class: 'equity-tab' }, [
    el('h2', { text: 'Equity calculator' }),
    el('p', {
      class: 'muted',
      text: 'Each player is a hand (AsKd) or a range (QQ+, AKs, A5s:0.5). Use Grid to pick a range by hand.',
    }),
    rowsEl,
    addBtn,
    el('div', { class: 'eq-fields' }, [
      el('label', {}, [el('span', { text: 'Board' }), boardInput, boardMsg]),
      el('label', {}, [el('span', { text: 'Dead cards' }), deadInput, deadMsg]),
    ]),
    el('div', { class: 'eq-actions' }, [
      el('label', {}, [el('span', { text: 'Method' }), methodSelect]),
      el('label', {}, [el('span', { text: 'MC trials' }), itersInput]),
      calcBtn,
      cancelBtn,
    ]),
    status,
  ]);
  const decision = createDecisionPanel();
  root.append(section, decision.element);

  // -- player rows ------------------------------------------------------------

  let rows = [];

  function updateRowInfo(row) {
    const info = classifyInput(row.input.value);
    row.input.classList.toggle('invalid', info.kind === 'error');
    if (info.kind === 'hand') row.info.textContent = 'Hand';
    else if (info.kind === 'range') {
      const c = info.combos;
      row.info.textContent = `Range · ${Number.isInteger(c) ? c : c.toFixed(1)} combos (${pct(c / 1326, 1)})`;
    } else if (info.kind === 'error') row.info.textContent = info.message;
    else row.info.textContent = 'Enter a hand or range';
    row.info.classList.toggle('error', info.kind === 'error');
    return info;
  }

  function markStale() {
    root.querySelectorAll('.eq-result').forEach((r) => r.classList.add('stale'));
  }

  function buildRows() {
    rowsEl.replaceChildren();
    rows = state.players.map((value, i) => {
      const input = el('input', {
        class: 'eq-input',
        value,
        spellcheck: false,
        placeholder: 'AsKd or QQ+, AKs',
        'aria-label': `Player ${i + 1} hand or range`,
      });
      const gridBtn = el('button', { type: 'button', class: 'eq-grid-btn', text: 'Grid', title: 'Edit as a range grid' });
      const removeBtn = el('button', {
        type: 'button',
        class: 'eq-remove',
        text: '×',
        title: 'Remove player',
        'aria-label': `Remove player ${i + 1}`,
        disabled: state.players.length <= MIN_PLAYERS,
      });
      const info = el('div', { class: 'eq-info' });
      const result = el('div', { class: 'eq-result' });
      const row = { input, info, result };
      rowsEl.append(
        el('div', { class: 'eq-row' }, [
          el('span', { class: 'eq-label', text: `P${i + 1}` }),
          input,
          gridBtn,
          removeBtn,
          info,
          result,
        ]),
      );
      input.addEventListener('input', () => {
        state.players[i] = input.value;
        updateRowInfo(row);
        markStale();
        persist();
      });
      gridBtn.addEventListener('click', () => openGrid(i));
      removeBtn.addEventListener('click', () => {
        state.players.splice(i, 1);
        persist();
        buildRows();
      });
      updateRowInfo(row);
      return row;
    });
    addBtn.disabled = state.players.length >= MAX_PLAYERS;
  }

  addBtn.addEventListener('click', () => {
    if (state.players.length >= MAX_PLAYERS) return;
    state.players.push('');
    persist();
    buildRows();
    rows[rows.length - 1].input.focus();
  });

  // -- range grid dialog ------------------------------------------------------

  async function openGrid(i) {
    const info = classifyInput(state.players[i]);
    let initial = new Map();
    if (info.kind === 'range') initial = info.range;
    else if (info.kind === 'hand') {
      try {
        initial = parseRange(state.players[i].replace(/s+/g, ''));
      } catch {
        initial = new Map();
      }
    }
    const range = await openRangeDialog({ title: `Range for P${i + 1}`, range: initial });
    if (!range || !rows[i]) return;
    state.players[i] = rangeToString(range);
    rows[i].input.value = state.players[i];
    updateRowInfo(rows[i]);
    markStale();
    persist();
  }

  // -- board, dead cards, options ------------------------------------------

  function checkBoard() {
    const msg = boardError(boardInput.value);
    boardInput.classList.toggle('invalid', !!msg);
    boardMsg.textContent = msg;
    return !msg;
  }

  function checkDead() {
    let msg = '';
    try {
      parseCards(deadInput.value);
    } catch (err) {
      msg = err.message;
    }
    deadInput.classList.toggle('invalid', !!msg);
    deadMsg.textContent = msg;
    return !msg;
  }

  boardInput.addEventListener('input', () => {
    state.board = boardInput.value;
    checkBoard();
    markStale();
    persist();
  });
  deadInput.addEventListener('input', () => {
    state.dead = deadInput.value;
    checkDead();
    markStale();
    persist();
  });
  methodSelect.addEventListener('change', () => {
    state.method = methodSelect.value;
    persist();
  });
  itersInput.addEventListener('change', () => {
    const n = Math.round(Number(itersInput.value));
    state.iterations = Number.isFinite(n) && n >= 1000 ? Math.min(n, 10000000) : DEFAULT_STATE.iterations;
    itersInput.value = state.iterations;
    persist();
  });

  // -- calculation ----------------------------------------------------------

  function showResults(result) {
    result.players.forEach((p, i) => {
      const row = rows[i];
      if (!row) return; // rows changed while calculating
      row.result.classList.remove('stale');
      const bar = el('div', { class: 'eq-bar' }, [el('span')]);
      bar.firstChild.style.width = pct(p.equity);
      const se = p.stdErr !== undefined ? ` ±${pct(p.stdErr)}` : '';
      row.result.replaceChildren(
        el('strong', { text: pct(p.equity) + se }),
        bar,
        el('small', { text: `win ${pct(p.win)} · tie ${pct(p.tie)}` }),
      );
    });
  }

  function describe(result) {
    const ms = result.elapsedMs;
    const secs = ms < 1000 ? `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
    if (result.method === 'exact') {
      return `Exact enumeration · ${result.runouts.toLocaleString()} runouts · ${secs}`;
    }
    return `Monte Carlo · ${result.iterations.toLocaleString()} trials · ${secs}`;
  }

  let running = false;
  async function calculate() {
    if (running) return;
    const infos = rows.map(updateRowInfo);
    const bad = infos.findIndex((x) => x.kind !== 'hand' && x.kind !== 'range');
    const okBoard = checkBoard();
    const okDead = checkDead();
    if (bad >= 0 || !okBoard || !okDead) {
      status.textContent = bad >= 0 ? `Fix player ${bad + 1} first.` : 'Fix the board or dead cards first.';
      status.className = 'eq-status error';
      return;
    }
    running = true;
    calcBtn.disabled = true;
    cancelBtn.disabled = false;
    status.className = 'eq-status';
    status.textContent = 'Calculating…';
    try {
      const result = await runEquity({
        method: state.method,
        players: state.players.map((p) => p.trim()),
        board: state.board,
        dead: state.dead,
        iterations: state.iterations,
      });
      showResults(result);
      status.textContent = describe(result);
      decision.setEquityResult(result);
    } catch (err) {
      status.className = err.name === 'AbortError' ? 'eq-status' : 'eq-status error';
      status.textContent = err.message;
    } finally {
      running = false;
      calcBtn.disabled = false;
      cancelBtn.disabled = true;
    }
  }

  calcBtn.addEventListener('click', calculate);
  cancelBtn.addEventListener('click', () => cancelEquity());
  section.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) calculate();
  });

  buildRows();
  checkBoard();
  checkDead();
}
