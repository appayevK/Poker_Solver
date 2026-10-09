// Nash tab: heads-up and table push/fold equilibria in chip EV, ICM and PKO.
import { positionLabels, nashAction } from '../../nash/pushfold.js';
import { rangePercent, classIndex } from '../../engine/ranges.js';
import { solveNash, cancelNash, cachedSolution } from '../../workers/nash-client.js';
import { createRangeGrid } from '../range-grid.js';
import { createPayoutsEditor, readPayouts } from '../payouts-editor.js';
import { el, field, readNumber, pct, fmt, signed } from '../dom.js';
import { load, save } from '../../storage/store.js';

const STORAGE_KEY = 'nashTab';
const DEFAULT_STATE = {
  view: 'table',
  hu: { stack: '10', ante: '0', bbAnte: false, sbBounty: '10', bbBounty: '10', otherStacks: '' },
  table: {
    seats: [15, 15, 15, 15, 15, 15].map((s) => ({ stack: String(s), bounty: '10' })),
    allStacks: '15',
    sb: '0.5',
    bb: '1',
    ante: '0',
    bbAnte: false,
  },
  mode: 'chipEV',
  pkoWithIcm: true,
  headValueFactor: '0',
  startingBounty: '10',
  startingStack: '100',
  payouts: { preset: 'final_table_9_example', text: '30, 20, 14, 10, 8, 6, 5, 4, 3', unit: '%', pool: '1000' },
  view_seat: 0,
  view_node: 'open',
  check: { hand: 'A9o', seat: 0, node: 'open' },
};

function formatGap(gap, unit) {
  if (!Number.isFinite(gap)) return '–';
  if (unit === '$') return `${gap >= 0 ? '+' : '−'}$${Math.abs(gap).toFixed(2)}`;
  return `${signed(gap, 2)} bb`;
}

function nodeLabel(node, positions) {
  return node === 'open' ? 'Open jam (folded to)' : `Call vs jam from ${positions[Number(node.slice(3))]}`;
}

export function renderNashTab(root) {
  const saved = load(STORAGE_KEY, null);
  const state = structuredClone(DEFAULT_STATE);
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULT_STATE)) {
      if (saved[k] === undefined) continue;
      state[k] = typeof DEFAULT_STATE[k] === 'object' && !Array.isArray(DEFAULT_STATE[k]) ? { ...DEFAULT_STATE[k], ...saved[k] } : saved[k];
    }
  }
  if (!Array.isArray(state.table.seats) || state.table.seats.length < 2) state.table.seats = structuredClone(DEFAULT_STATE.table.seats);
  const persist = () => save(STORAGE_KEY, state);

  let solution = null;
  let solvedFor = null; // params key the solution belongs to
  let solving = false;

  // -- view switch ----------------------------------------------------------

  const viewButtons = ['headsUp', 'table'].map((view) => {
    const b = el('button', { type: 'button', text: view === 'headsUp' ? 'Heads-up' : 'Table', 'aria-pressed': String(state.view === view) });
    b.addEventListener('click', () => {
      state.view = view;
      viewButtons.forEach((x, i) => x.setAttribute('aria-pressed', String(['headsUp', 'table'][i] === view)));
      inputsChanged();
    });
    return b;
  });

  // -- inputs -----------------------------------------------------------------

  const bindNum = (obj, key, props = {}) => {
    const input = el('input', { type: 'number', inputMode: 'decimal', min: 0, step: 'any', value: obj[key], ...props });
    input.addEventListener('input', () => {
      obj[key] = input.value;
      inputsChanged();
    });
    return input;
  };
  const bindCheck = (obj, key, label) => {
    const input = el('input', { type: 'checkbox', checked: !!obj[key] });
    input.addEventListener('change', () => {
      obj[key] = input.checked;
      inputsChanged();
    });
    return el('label', { class: 'check' }, [input, el('span', { text: label })]);
  };

  // Heads-up inputs
  const huOther = el('input', { value: state.hu.otherStacks, placeholder: 'e.g. 8, 20', spellcheck: false });
  huOther.addEventListener('input', () => {
    state.hu.otherStacks = huOther.value;
    inputsChanged();
  });
  const huOtherField = field('Other stacks, bb (ICM)', huOther);
  const huBounties = el('div', { class: 'icm-row' }, [
    field('SB bounty $', bindNum(state.hu, 'sbBounty')),
    field('BB bounty $', bindNum(state.hu, 'bbBounty')),
  ]);
  const huPanel = el('div', {}, [
    el('div', { class: 'icm-row' }, [
      field('Effective stack (bb)', bindNum(state.hu, 'stack')),
      field('Ante (bb)', bindNum(state.hu, 'ante')),
      bindCheck(state.hu, 'bbAnte', 'BB ante'),
    ]),
  ]);

  // Table inputs
  const seatCount = el(
    'select',
    { 'aria-label': 'Players' },
    [2, 3, 4, 5, 6, 7, 8, 9].map((k) => el('option', { value: String(k), text: `${k} players` })),
  );
  seatCount.value = String(state.table.seats.length);
  const seatsEl = el('div', { class: 'nash-seats' });
  const allStacks = bindNum(state.table, 'allStacks');
  const applyAll = el('button', { type: 'button', text: 'Set all' });
  seatCount.addEventListener('change', () => {
    const k = Number(seatCount.value);
    const seats = state.table.seats;
    while (seats.length < k) seats.unshift({ stack: state.table.allStacks || '15', bounty: seats[0]?.bounty ?? '10' });
    while (seats.length > k) seats.shift();
    buildSeats();
    inputsChanged();
  });
  applyAll.addEventListener('click', () => {
    for (const s of state.table.seats) s.stack = state.table.allStacks;
    buildSeats();
    inputsChanged();
  });

  function buildSeats() {
    const labels = positionLabels(state.table.seats.length);
    const showBounty = state.mode === 'pko';
    seatsEl.replaceChildren(
      el('div', { class: `nash-seat head${showBounty ? ' pko' : ''}` }, [
        el('span', { text: 'Seat' }),
        el('span', { text: 'Stack (bb)' }),
        showBounty ? el('span', { text: 'Bounty $' }) : null,
      ]),
      ...state.table.seats.map((s, i) =>
        el('div', { class: `nash-seat${showBounty ? ' pko' : ''}` }, [
          el('span', { class: 'pos', text: labels[i] }),
          bindNum(s, 'stack', { 'aria-label': `${labels[i]} stack` }),
          showBounty ? bindNum(s, 'bounty', { 'aria-label': `${labels[i]} bounty` }) : null,
        ]),
      ),
    );
  }

  const tablePanel = el('div', {}, [
    el('div', { class: 'icm-row' }, [field('Players', seatCount), field('All stacks (bb)', allStacks), applyAll]),
    seatsEl,
    el('div', { class: 'icm-row' }, [
      field('SB (bb)', bindNum(state.table, 'sb')),
      field('BB (bb)', bindNum(state.table, 'bb')),
      field('Ante (bb)', bindNum(state.table, 'ante')),
      bindCheck(state.table, 'bbAnte', 'BB ante'),
    ]),
  ]);

  // Mode
  const modeSelect = el('select', { 'aria-label': 'Mode' }, [
    el('option', { value: 'chipEV', text: 'Chip EV' }),
    el('option', { value: 'icm', text: 'ICM' }),
    el('option', { value: 'pko', text: 'PKO' }),
  ]);
  modeSelect.value = state.mode;
  modeSelect.addEventListener('change', () => {
    state.mode = modeSelect.value;
    buildSeats();
    inputsChanged();
  });
  const payoutsEditor = createPayoutsEditor(state.payouts, () => inputsChanged());
  const pkoIcmCheck = bindCheck(state, 'pkoWithIcm', 'Include ICM (payouts)');
  const pkoRow = el('div', { class: 'icm-row' }, [pkoIcmCheck, field('Head-value factor', bindNum(state, 'headValueFactor', { max: 1, step: 0.05 }))]);
  const chipPkoRow = el('div', { class: 'icm-row' }, [
    field('Starting bounty $', bindNum(state, 'startingBounty')),
    field('Starting stack (bb)', bindNum(state, 'startingStack')),
  ]);

  // -- solve controls -------------------------------------------------------

  const solveBtn = el('button', { type: 'button', class: 'primary', text: 'Solve' });
  const cancelBtn = el('button', { type: 'button', text: 'Cancel', disabled: true });
  const bar = el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, [el('span')]);
  const status = el('p', { class: 'nash-status', 'aria-live': 'polite' });

  // -- output ---------------------------------------------------------------

  const seatSelect = el('select', { 'aria-label': 'Seat' });
  const nodeSelect = el('select', { 'aria-label': 'Decision' });
  const summary = el('p', { class: 'nash-summary' });
  const cellInfo = el('p', { class: 'nash-cell muted', text: 'Hover or tap a hand to see its EV gap.' });
  const grid = createRangeGrid({ range: new Map(), readOnly: true });
  const outputPanel = el('div', { class: 'panel wide nash-output' }, [
    el('h3', { text: 'Ranges' }),
    el('div', { class: 'icm-row' }, [field('Seat', seatSelect), field('Decision', nodeSelect)]),
    summary,
    grid,
    cellInfo,
  ]);

  // Check my hand
  const checkHand = el('input', { value: state.check.hand, spellcheck: false, placeholder: 'A9o or AsKd', 'aria-label': 'Hand to check' });
  const checkSeat = el('select', { 'aria-label': 'Seat to check' });
  const checkNode = el('select', { 'aria-label': 'Decision to check' });
  const checkOut = el('div', { class: 'nash-check-out' });
  const checkPanel = el('div', { class: 'panel' }, [
    el('h3', { text: 'Check my hand' }),
    el('div', { class: 'icm-row' }, [field('Hand', checkHand), field('Seat', checkSeat), field('Decision', checkNode)]),
    checkOut,
  ]);

  // Compare modes
  const compareBtn = el('button', { type: 'button', text: 'Compare chip EV vs ICM' });
  const compareStatus = el('p', { class: 'muted small' });
  const compareGrids = el('div', { class: 'nash-compare' });
  const comparePanel = el('div', { class: 'panel' }, [
    el('h3', { text: 'Compare modes' }),
    el('p', { class: 'muted small', text: 'The same spot and decision in chip EV and ICM, side by side (uses the payouts above).' }),
    compareBtn,
    compareStatus,
    compareGrids,
  ]);

  const modePanel = el('div', { class: 'panel' }, [
    el('h3', { text: 'Model' }),
    el('div', { class: 'icm-row' }, [field('Mode', modeSelect)]),
    pkoRow,
    chipPkoRow,
    payoutsEditor.element,
    huOtherField,
    huBounties,
  ]);

  const section = el('section', { class: 'nash-tab' }, [
    el('h2', { text: 'Nash push/fold' }),
    el('p', {
      class: 'muted',
      text: 'Jam-or-fold equilibria. Stacks and blinds in big blinds; every all-in is heads-up (once someone calls, the rest fold).',
    }),
    el('div', { class: 'segmented', role: 'group', 'aria-label': 'Spot type' }, viewButtons),
    el('div', { class: 'icm-layout' }, [
      el('div', { class: 'panel' }, [el('h3', { text: 'Spot' }), huPanel, tablePanel]),
      modePanel,
      el('div', { class: 'panel wide' }, [el('div', { class: 'nash-actions' }, [solveBtn, cancelBtn, bar]), status]),
      outputPanel,
      checkPanel,
      comparePanel,
    ]),
  ]);
  root.append(section);

  // -- parameters -------------------------------------------------------------

  /** Solver request for the current inputs (mode overridable), or throws a user-facing error. */
  function buildParams(modeOverride) {
    const mode = modeOverride ?? state.mode;
    const num = (value, name, { positive = false } = {}) => {
      const n = value === '' ? NaN : Number(value);
      if (!Number.isFinite(n) || n < 0 || (positive && n === 0)) throw new Error(`Enter a valid ${name}`);
      return n;
    };
    const useIcm = mode === 'icm' || (mode === 'pko' && state.pkoWithIcm);
    let payouts;
    if (useIcm) {
      try {
        payouts = readPayouts(state.payouts).payouts;
      } catch (err) {
        throw new Error(`Payouts: ${err.message}`);
      }
    }
    const headValueFactor = mode === 'pko' ? num(state.headValueFactor, 'head-value factor') : undefined;
    if (headValueFactor > 1) throw new Error('Head-value factor must be between 0 and 1');
    const chipPko = mode === 'pko' && !useIcm ? { startingBounty: num(state.startingBounty, 'starting bounty', { positive: true }), startingStack: num(state.startingStack, 'starting stack', { positive: true }) } : {};

    if (state.view === 'headsUp') {
      const stackBB = num(state.hu.stack, 'stack', { positive: true });
      const otherStacks = useIcm && state.hu.otherStacks.trim()
        ? state.hu.otherStacks.split(/[\s,;]+/).filter(Boolean).map((x) => num(x, 'other stack'))
        : [];
      return {
        method: 'headsUp',
        stackBB,
        ante: num(state.hu.ante, 'ante'),
        bbAnte: !!state.hu.bbAnte,
        mode,
        icm: useIcm ? { payouts, otherStacks } : undefined,
        pko: mode === 'pko' ? { bounties: [num(state.hu.sbBounty, 'SB bounty'), num(state.hu.bbBounty, 'BB bounty')], headValueFactor, ...chipPko } : undefined,
      };
    }
    const labels = positionLabels(state.table.seats.length);
    return {
      method: 'table',
      stacks: state.table.seats.map((s, i) => num(s.stack, `${labels[i]} stack`, { positive: true })),
      blinds: { sb: num(state.table.sb, 'small blind'), bb: num(state.table.bb, 'big blind'), ante: num(state.table.ante, 'ante'), bbAnte: !!state.table.bbAnte },
      mode,
      payouts,
      bounties: mode === 'pko' ? state.table.seats.map((s, i) => num(s.bounty, `${labels[i]} bounty`)) : undefined,
      headValueFactor,
      ...chipPko,
    };
  }

  const paramsKey = (p) => JSON.stringify(p);
  const tolerance = (p) => {
    const payouts = p.payouts ?? p.icm?.payouts;
    return payouts ? 2e-6 * payouts.reduce((a, b) => a + b, 0) : 2e-4;
  };

  // -- rendering --------------------------------------------------------------

  function visibility() {
    const hu = state.view === 'headsUp';
    huPanel.hidden = !hu;
    tablePanel.hidden = hu;
    const useIcm = state.mode === 'icm' || (state.mode === 'pko' && state.pkoWithIcm);
    pkoRow.hidden = state.mode !== 'pko';
    chipPkoRow.hidden = !(state.mode === 'pko' && !state.pkoWithIcm);
    payoutsEditor.element.hidden = !useIcm;
    huOtherField.hidden = !(hu && useIcm);
    huBounties.hidden = !(hu && state.mode === 'pko');
  }

  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map(([v, text]) => el('option', { value: v, text })));
    select.value = options.some(([v]) => v === value) ? value : options[0]?.[0] ?? '';
    return select.value;
  }

  function seatOptions(sol) {
    return sol.positions.map((p, i) => [String(i), `${p} (${fmt(sol.stacks[i], 1)} bb)`]);
  }

  function nodeOptions(sol, seat) {
    const opts = [];
    if (seat < sol.positions.length - 1) opts.push(['open', nodeLabel('open', sol.positions)]);
    for (let i = 0; i < seat; i++) opts.push([`vs:${i}`, nodeLabel(`vs:${i}`, sol.positions)]);
    return opts;
  }

  function findNode(sol, seat, node) {
    const id = node === 'open' ? `open:${seat}` : `call:${node.slice(3)}:${seat}`;
    return sol.nodes.find((x) => x.id === id);
  }

  function rangeOf(sol, seat, node) {
    const s = sol.seats[seat];
    return node === 'open' ? s.openJam : s.callVs[Number(node.slice(3))];
  }

  let shownNode = null;
  function renderOutput() {
    outputPanel.hidden = !solution;
    checkPanel.hidden = !solution;
    if (!solution) return;
    const seat = Number(fillSelect(seatSelect, seatOptions(solution), String(state.view_seat)));
    state.view_seat = seat;
    state.view_node = fillSelect(nodeSelect, nodeOptions(solution, seat), state.view_node);
    const range = rangeOf(solution, seat, state.view_node);
    shownNode = findNode(solution, seat, state.view_node);
    grid.setRange(range);
    const verb = state.view_node === 'open' ? 'jams' : 'calls';
    summary.textContent = `${solution.positions[seat]} ${verb} ${pct(rangePercent(range), 1)} of hands · ${nodeLabel(state.view_node, solution.positions)}`;
    cellInfo.textContent = 'Hover or tap a hand to see its EV gap.';
    renderCheck();
  }

  function showCell(cls) {
    if (!shownNode || !cls) return;
    const ci = classIndex(cls);
    if (ci < 0) return;
    const freq = shownNode.strategy[ci];
    const verb = shownNode.type === 'open' ? 'jam' : 'call';
    cellInfo.textContent = `${cls}: ${verb} ${pct(freq, 0)} · EV gap ${formatGap(shownNode.evGap[ci], solution.unit)} (${verb} minus fold)`;
  }
  grid.addEventListener('pointerover', (e) => showCell(e.target.closest?.('.rg-cell')?.dataset.cls));
  grid.addEventListener('click', (e) => showCell(e.target.closest?.('.rg-cell')?.dataset.cls));

  function renderCheck() {
    if (!solution) return;
    const seat = Number(fillSelect(checkSeat, seatOptions(solution), String(state.check.seat)));
    state.check.seat = seat;
    state.check.node = fillSelect(checkNode, nodeOptions(solution, seat), state.check.node);
    try {
      const r = nashAction(solution, { seat, node: state.check.node === 'open' ? 'open' : state.check.node, handClass: state.check.hand });
      const mixed = r.frequency > 0.01 && r.frequency < 0.99;
      checkOut.replaceChildren(
        el('div', { class: `badge ${r.action === 'fold' ? 'bad' : 'good'}`, text: `${r.action.toUpperCase()}${mixed ? ` (${pct(r.frequency, 0)} of the time)` : ''}` }),
        el('p', {
          class: 'muted small',
          text: `EV gap ${formatGap(r.evGap, r.unit)}: how much better ${r.action === 'fold' ? 'folding' : r.action === 'jam' ? 'jamming' : 'calling'} is than the alternative${Math.abs(r.evGap) < 0.05 && r.unit === 'bb' ? ' (a close decision)' : ''}.`,
        }),
      );
    } catch (err) {
      checkOut.replaceChildren(el('p', { class: 'icm-msg error', text: err.message }));
    }
  }

  checkHand.addEventListener('input', () => {
    state.check.hand = checkHand.value;
    persist();
    renderCheck();
  });
  checkSeat.addEventListener('change', () => {
    state.check.seat = Number(checkSeat.value);
    persist();
    renderCheck();
  });
  checkNode.addEventListener('change', () => {
    state.check.node = checkNode.value;
    persist();
    renderCheck();
  });
  seatSelect.addEventListener('change', () => {
    state.view_seat = Number(seatSelect.value);
    persist();
    renderOutput();
  });
  nodeSelect.addEventListener('change', () => {
    state.view_node = nodeSelect.value;
    persist();
    renderOutput();
  });

  function describe(sol) {
    // Heads-up solutions report one number; table solutions one per seat.
    const worst = Array.isArray(sol.exploitability) ? Math.max(...sol.exploitability) : sol.exploitability;
    const unit = sol.unit === '$' ? '$' : 'bb';
    const e = unit === '$' ? `$${worst.toPrecision(2)}` : `${worst.toPrecision(2)} bb`;
    const time = sol.cached ? 'loaded from cache' : `solved in ${(sol.elapsedMs / 1000).toFixed(2)} s`;
    return `${time} · ${sol.iterations.toLocaleString()} iterations · exploitability ${e} per player${sol.converged ? '' : ' (stopped at the iteration limit)'}`;
  }

  // -- actions ------------------------------------------------------------------

  function setProgress(fraction) {
    bar.firstChild.style.width = `${Math.round(fraction * 100)}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  }

  async function runSolve() {
    if (solving) return;
    let params;
    try {
      params = buildParams();
    } catch (err) {
      status.className = 'nash-status error';
      status.textContent = err.message;
      return;
    }
    solving = true;
    solveBtn.disabled = true;
    cancelBtn.disabled = false;
    status.className = 'nash-status';
    status.textContent = 'Solving…';
    setProgress(0);
    const tol = tolerance(params);
    let first = null;
    try {
      const sol = await solveNash(params, {
        onProgress: ({ iteration, exploitability }) => {
          first ??= Math.max(exploitability, tol * 1.0001);
          const f = Math.log(first / Math.max(exploitability, tol)) / Math.log(first / tol);
          setProgress(Math.min(1, Math.max(0, f)));
          const unit = params.payouts || params.icm ? '$' : 'bb';
          status.textContent = `Iteration ${iteration} · exploitability ${exploitability.toPrecision(2)} ${unit}`;
        },
      });
      setProgress(1);
      solution = sol;
      solvedFor = paramsKey(params);
      status.textContent = describe(sol);
      renderOutput();
    } catch (err) {
      status.className = err.name === 'AbortError' ? 'nash-status' : 'nash-status error';
      status.textContent = err.message;
      setProgress(0);
    } finally {
      solving = false;
      solveBtn.disabled = false;
      cancelBtn.disabled = true;
    }
  }

  async function runCompare() {
    let chip;
    let icm;
    try {
      chip = buildParams('chipEV');
      icm = buildParams('icm');
    } catch (err) {
      compareStatus.textContent = err.message;
      return;
    }
    compareBtn.disabled = true;
    compareStatus.textContent = 'Solving chip EV and ICM…';
    try {
      const [a, b] = [await solveNash(chip), await solveNash(icm)];
      const seat = Math.min(state.view_seat, a.positions.length - 1);
      const opts = nodeOptions(a, seat);
      const node = opts.some(([v]) => v === state.view_node) ? state.view_node : opts[0][0];
      const panel = (label, sol) => {
        const range = rangeOf(sol, seat, node);
        return el('div', { class: 'nash-compare-item' }, [
          el('h4', { text: `${label}: ${pct(rangePercent(range), 1)}` }),
          createRangeGrid({ range, readOnly: true }),
        ]);
      };
      compareGrids.replaceChildren(panel('Chip EV', a), panel('ICM', b));
      compareStatus.textContent = `${a.positions[seat]} · ${nodeLabel(node, a.positions)}`;
    } catch (err) {
      compareStatus.textContent = err.message;
    } finally {
      compareBtn.disabled = false;
    }
  }

  solveBtn.addEventListener('click', runSolve);
  cancelBtn.addEventListener('click', () => cancelNash());
  compareBtn.addEventListener('click', runCompare);

  function inputsChanged() {
    persist();
    visibility();
    let params = null;
    try {
      params = buildParams();
      payoutsEditor.setMessage('');
    } catch (err) {
      if (err.message.startsWith('Payouts:')) payoutsEditor.setMessage(err.message.slice(9));
    }
    if (solution && params && paramsKey(params) === solvedFor) {
      outputPanel.classList.remove('stale');
      return;
    }
    const cached = params ? cachedSolution(params) : null;
    if (cached) {
      solution = cached;
      solvedFor = paramsKey(params);
      status.className = 'nash-status';
      status.textContent = describe(cached);
      setProgress(1);
      outputPanel.classList.remove('stale');
      renderOutput();
    } else if (solution) {
      outputPanel.classList.add('stale');
      status.className = 'nash-status';
      status.textContent = 'Inputs changed: press Solve to update the ranges.';
      setProgress(0);
    }
  }

  buildSeats();
  visibility();
  renderOutput();
  inputsChanged();
}
