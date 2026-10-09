// ICM tab: stacks + payouts → $EV, plus a hero-vs-villain jam/call spot calculator.
import {
  icmEquity,
  spotEV,
  icmRequiredEquity,
  chipRequiredEquity,
} from '../../calc/icm.js';
import { parseCards } from '../../engine/cards.js';
import { parseRange, rangeToString } from '../../engine/ranges.js';
import { countCombos, combosForClass } from '../../engine/combos.js';
import { runEquity } from '../../workers/client.js';
import { openRangeDialog } from '../range-dialog.js';
import { createPayoutsEditor, readPayouts } from '../payouts-editor.js';
import { el, field, readNumber, pct, fmt, signed } from '../dom.js';
import { load, save } from '../../storage/store.js';

const STORAGE_KEY = 'icmTab';
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const DEFAULT_STATE = {
  players: [
    { name: 'P1', stack: '4000', bounty: '' },
    { name: 'P2', stack: '3000', bounty: '' },
    { name: 'P3', stack: '2000', bounty: '' },
    { name: 'P4', stack: '1000', bounty: '' },
  ],
  preset: 'sng_3_way',
  payoutText: '50, 30, 20',
  unit: '%',
  prizePool: '1000',
  spot: {
    hero: 3,
    villain: 1,
    action: 'jam',
    sb: '100',
    bb: '200',
    ante: '0',
    bbAnte: false,
    sbSeat: 3,
    bbSeat: 1,
    mode: 'range',
    hand: 'A9o',
    range: '22+, A2s+, A8o+, KTs+, KQo',
    equity: '45',
    foldFreq: '60',
    pko: false,
    headValueFactor: '0',
  },
};

const money = (x) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : '–');

/** Required equity as text, flagging values outside 0..100%. */
function requiredText(x) {
  if (x === null) return 'n/a (equity does not matter)';
  if (x > 1) return 'over 100%: never profitable';
  if (x < 0) return '0%: fold equity alone pays';
  return pct(x, 1);
}

export function renderIcmTab(root) {
  const saved = load(STORAGE_KEY, null);
  const state = structuredClone(DEFAULT_STATE);
  if (saved && typeof saved === 'object') {
    Object.assign(state, saved, { spot: { ...DEFAULT_STATE.spot, ...(saved.spot ?? {}) } });
  }
  if (!Array.isArray(state.players) || state.players.length < MIN_PLAYERS) state.players = structuredClone(DEFAULT_STATE.players);
  state.players = state.players.slice(0, MAX_PLAYERS);
  const persist = () => save(STORAGE_KEY, state);
  const spot = state.spot;

  // -- players ------------------------------------------------------------

  const playersEl = el('div', { class: 'icm-players' });
  const addBtn = el('button', { type: 'button', text: '+ Add player' });

  function buildPlayers() {
    playersEl.replaceChildren(
      el('div', { class: 'icm-player head' }, [
        el('span', { text: '#' }),
        el('span', { text: 'Name' }),
        el('span', { text: 'Stack' }),
        el('span', { text: 'Bounty $' }),
        el('span'),
      ]),
    );
    state.players.forEach((p, i) => {
      const name = el('input', { value: p.name, 'aria-label': `Player ${i + 1} name` });
      const stack = el('input', { type: 'number', inputMode: 'decimal', min: 0, step: 'any', value: p.stack, 'aria-label': `Player ${i + 1} stack` });
      const bounty = el('input', {
        type: 'number',
        inputMode: 'decimal',
        min: 0,
        step: 'any',
        value: p.bounty,
        placeholder: 'optional',
        'aria-label': `Player ${i + 1} bounty`,
      });
      const remove = el('button', {
        type: 'button',
        class: 'icon',
        text: '×',
        'aria-label': `Remove player ${i + 1}`,
        disabled: state.players.length <= MIN_PLAYERS,
      });
      name.addEventListener('input', () => {
        p.name = name.value;
        refreshSeats();
        changed();
      });
      stack.addEventListener('input', () => {
        p.stack = stack.value;
        changed();
      });
      bounty.addEventListener('input', () => {
        p.bounty = bounty.value;
        changed();
      });
      remove.addEventListener('click', () => {
        state.players.splice(i, 1);
        for (const k of ['hero', 'villain', 'sbSeat', 'bbSeat']) {
          if (spot[k] === i) spot[k] = k === 'sbSeat' || k === 'bbSeat' ? -1 : 0;
          else if (spot[k] > i) spot[k]--;
        }
        buildPlayers();
        refreshSeats();
        changed();
      });
      playersEl.append(el('div', { class: 'icm-player' }, [el('span', { class: 'muted', text: String(i + 1) }), name, stack, bounty, remove]));
    });
    addBtn.disabled = state.players.length >= MAX_PLAYERS;
  }

  addBtn.addEventListener('click', () => {
    if (state.players.length >= MAX_PLAYERS) return;
    state.players.push({ name: `P${state.players.length + 1}`, stack: '1000', bounty: '' });
    buildPlayers();
    refreshSeats();
    changed();
  });

  // -- payouts ------------------------------------------------------------

  // The editor works on its own state object; mirror it into the persisted fields.
  const payoutState = { preset: state.preset, text: state.payoutText, unit: state.unit, pool: state.prizePool };
  const payoutsEditor = createPayoutsEditor(payoutState, () => {
    state.preset = payoutState.preset;
    state.payoutText = payoutState.text;
    state.unit = payoutState.unit;
    state.prizePool = payoutState.pool;
    changed();
  });

  // -- results ------------------------------------------------------------

  const resultsEl = el('div', { class: 'icm-results' });
  const resultsMsg = el('div', { class: 'icm-msg', role: 'alert' });

  /** Current model inputs, or throws with a message for the user. */
  function model() {
    const stacks = state.players.map((p, i) => {
      const n = Number(p.stack);
      if (p.stack === '' || !Number.isFinite(n) || n < 0) throw new Error(`Enter a stack of 0 or more for ${p.name || `player ${i + 1}`}`);
      return n;
    });
    const { payouts, prizePool } = readPayouts(payoutState);
    const bounties = state.players.map((p) => {
      const n = Number(p.bounty);
      return p.bounty === '' || !Number.isFinite(n) || n < 0 ? 0 : n;
    });
    return { stacks, payouts, prizePool, bounties };
  }

  function updateResults(m) {
    const ev = icmEquity(m.stacks, m.payouts);
    const chips = m.stacks.reduce((a, b) => a + b, 0);
    const paid = ev.reduce((a, b) => a + b, 0);
    const table = el('table', {}, [
      el('thead', {}, [
        el('tr', {}, ['Player', 'Chips %', '$EV', '$ %', '% of pool'].map((h) => el('th', { text: h }))),
      ]),
      el(
        'tbody',
        {},
        state.players.map((p, i) => {
          const chipShare = m.stacks[i] / chips;
          const dollarShare = paid > 0 ? ev[i] / paid : 0;
          const diff = dollarShare - chipShare;
          return el('tr', {}, [
            el('td', { text: p.name || `P${i + 1}` }),
            el('td', { text: pct(chipShare, 1) }),
            el('td', { text: money(ev[i]) }),
            el('td', { class: Math.abs(diff) < 5e-4 ? '' : diff > 0 ? 'up' : 'down', text: pct(dollarShare, 1) }),
            el('td', { text: pct(ev[i] / m.prizePool, 1) }),
          ]);
        }),
      ),
      el('tfoot', {}, [
        el('tr', {}, [
          el('td', { text: 'Total' }),
          el('td', { text: '100%' }),
          el('td', { text: money(paid) }),
          el('td', { text: '100%' }),
          el('td', { text: pct(paid / m.prizePool, 1) }),
        ]),
      ]),
    ]);
    const active = m.stacks.filter((s) => s > 0).length;
    const note =
      m.payouts.length > active
        ? `Only the top ${active} of ${m.payouts.length} payouts are still in play.`
        : m.payouts.length < active
          ? `${active - m.payouts.length} of ${active} players finish out of the money.`
          : '';
    resultsEl.replaceChildren(el('div', { class: 'table-wrap' }, [table]), note ? el('p', { class: 'muted small', text: note }) : '');
  }

  // -- spot ---------------------------------------------------------------

  const heroSelect = el('select', { 'aria-label': 'Hero' });
  const villainSelect = el('select', { 'aria-label': 'Villain' });
  const sbSelect = el('select', { 'aria-label': 'Small blind seat' });
  const bbSelect = el('select', { 'aria-label': 'Big blind seat' });
  const actionSelect = el('select', { 'aria-label': 'Action' }, [
    el('option', { value: 'jam', text: 'Hero jams' }),
    el('option', { value: 'call', text: "Hero calls villain's jam" }),
  ]);
  actionSelect.value = spot.action;

  function refreshSeats() {
    const n = state.players.length;
    const names = state.players.map((p, i) => p.name || `P${i + 1}`);
    const fill = (select, key, allowNone) => {
      select.replaceChildren(
        ...(allowNone ? [el('option', { value: '-1', text: '—' })] : []),
        ...names.map((name, i) => el('option', { value: String(i), text: name })),
      );
      if (!(spot[key] >= (allowNone ? -1 : 0) && spot[key] < n)) spot[key] = allowNone ? -1 : 0;
      select.value = String(spot[key]);
    };
    fill(heroSelect, 'hero', false);
    fill(villainSelect, 'villain', false);
    fill(sbSelect, 'sbSeat', true);
    fill(bbSelect, 'bbSeat', true);
  }

  for (const [select, key] of [[heroSelect, 'hero'], [villainSelect, 'villain'], [sbSelect, 'sbSeat'], [bbSelect, 'bbSeat']]) {
    select.addEventListener('change', () => {
      spot[key] = Number(select.value);
      changed();
    });
  }
  actionSelect.addEventListener('change', () => {
    spot.action = actionSelect.value;
    changed();
  });

  const spotNum = (key, props = {}) => {
    const input = el('input', { type: 'number', inputMode: 'decimal', min: 0, step: 'any', value: spot[key], ...props });
    input.addEventListener('input', () => {
      spot[key] = input.value;
      changed();
    });
    return input;
  };
  const spotCheck = (key, label) => {
    const input = el('input', { type: 'checkbox', checked: !!spot[key] });
    input.addEventListener('change', () => {
      spot[key] = input.checked;
      changed();
    });
    return el('label', { class: 'check' }, [input, el('span', { text: label })]);
  };
  const sbInput = spotNum('sb');
  const bbInput = spotNum('bb');
  const anteInput = spotNum('ante');
  const equityInput = spotNum('equity', { max: 100 });
  const foldInput = spotNum('foldFreq', { max: 100 });
  const hvfInput = spotNum('headValueFactor', { max: 1, step: 0.05 });

  const modeRadios = ['range', 'manual'].map((mode) => {
    const input = el('input', { type: 'radio', name: 'icm-eq-mode', value: mode, checked: spot.mode === mode });
    input.addEventListener('change', () => {
      spot.mode = mode;
      changed();
    });
    return el('label', { class: 'check' }, [input, el('span', { text: mode === 'range' ? 'Hand vs range' : 'Manual equity' })]);
  });

  const handInput = el('input', { value: spot.hand, spellcheck: false, placeholder: 'AsKd', 'aria-label': 'Hero hand' });
  const rangeInput = el('input', { value: spot.range, spellcheck: false, placeholder: '22+, A2s+, KTo+', 'aria-label': 'Villain range' });
  const rangeLabel = el('span');
  const gridBtn = el('button', { type: 'button', text: 'Grid' });
  const eqBtn = el('button', { type: 'button', class: 'primary', text: 'Calculate equity' });
  const eqInfo = el('div', { class: 'icm-msg' });
  handInput.addEventListener('input', () => {
    spot.hand = handInput.value;
    changed();
  });
  rangeInput.addEventListener('input', () => {
    spot.range = rangeInput.value;
    changed();
  });
  gridBtn.addEventListener('click', async () => {
    let initial = new Map();
    try {
      initial = parseRange(spot.range);
    } catch {
      // start from an empty grid
    }
    const range = await openRangeDialog({ title: `Villain's ${spot.action === 'jam' ? 'calling' : 'jamming'} range`, range: initial });
    if (!range) return;
    spot.range = rangeToString(range);
    rangeInput.value = spot.range;
    changed();
  });

  let equityResult = null; // { key, equity, tie }
  const equityKey = () => `${spot.hand.trim()}|${spot.range.trim()}`;

  /**
   * Hero's hand (exact cards like AsKd, or one class like A9o) and villain's range.
   * callShare = villain's share of the 1225 hands left once hero's cards are removed,
   * averaged over hero's combos.
   */
  function handAndRange() {
    let heroCombos = null;
    try {
      const cards = parseCards(spot.hand);
      if (cards.length === 2) heroCombos = [cards];
    } catch {
      // not exact cards; try a hand class below
    }
    if (!heroCombos) {
      const cls = spot.hand.trim();
      let parsed = null;
      try {
        parsed = parseRange(cls);
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.size !== 1 || !parsed.has(cls)) {
        throw new Error('Hero hand: enter exact cards (AsKd) or one hand class (A9o, 77, KQs)');
      }
      heroCombos = combosForClass(cls);
    }
    let range;
    try {
      range = parseRange(spot.range);
    } catch (err) {
      throw new Error(`Villain range: ${err.message}`);
    }
    const combos = heroCombos.map((cards) => countCombos(range, cards));
    if (combos.every((c) => c <= 0)) throw new Error('Villain range is empty after card removal');
    const callShare = combos.reduce((a, b) => a + b, 0) / combos.length / 1225;
    return { range, callShare };
  }

  eqBtn.addEventListener('click', async () => {
    let parsed;
    try {
      parsed = handAndRange();
    } catch (err) {
      eqInfo.textContent = err.message;
      eqInfo.className = 'icm-msg error';
      return;
    }
    const key = equityKey();
    eqBtn.disabled = true;
    eqInfo.className = 'icm-msg';
    eqInfo.textContent = 'Calculating…';
    try {
      const result = await runEquity({ method: 'auto', players: [spot.hand.trim(), parsed.range] });
      equityResult = { key, equity: result.players[0].equity, tie: result.players[0].tie };
    } catch (err) {
      eqInfo.textContent = err.message;
      eqInfo.className = 'icm-msg error';
    } finally {
      eqBtn.disabled = false;
    }
    updateSpot();
  });

  const rangeRow = el('div', { class: 'icm-row' }, [
    field('Hero hand', handInput),
    el('label', { class: 'field grow' }, [rangeLabel, rangeInput]),
    gridBtn,
    eqBtn,
  ]);
  const foldField = field('Villain folds %', foldInput);
  const manualRow = el('div', { class: 'icm-row' }, [field('Hero equity %', equityInput), foldField]);
  const pkoRow = el('div', { class: 'icm-row' }, [
    spotCheck('pko', 'PKO bounties (uses the Bounty column)'),
    field('Head-value factor', hvfInput),
  ]);
  const spotOut = el('div', { class: 'icm-spot-out' });

  /** Equity, tie and fold frequency for the spot, or a reason they are missing. */
  function spotInputs() {
    if (spot.mode === 'manual') {
      const e = readNumber(equityInput);
      const f = readNumber(foldInput);
      if (e === null) return { missing: 'Enter hero equity' };
      return { equity: e / 100, tie: 0, foldFreq: spot.action === 'jam' ? (f ?? 0) / 100 : 0 };
    }
    const { callShare } = handAndRange();
    const foldFreq = spot.action === 'jam' ? 1 - callShare : 0;
    if (!equityResult || equityResult.key !== equityKey()) return { foldFreq, missing: 'Press Calculate equity' };
    return { equity: equityResult.equity, tie: equityResult.tie, foldFreq };
  }

  function stat(label, value, cls = '') {
    return el('div', { class: `stat ${cls}` }, [el('span', { text: label }), el('strong', { text: value })]);
  }

  function updateSpot(m) {
    rangeLabel.textContent = spot.action === 'jam' ? "Villain's calling range" : "Villain's jamming range";
    rangeRow.hidden = spot.mode !== 'range';
    manualRow.hidden = spot.mode !== 'manual';
    foldField.hidden = spot.action !== 'jam';
    hvfInput.closest('.field').hidden = !spot.pko;
    eqInfo.hidden = spot.mode !== 'range';
    if (!m) {
      try {
        m = model();
      } catch {
        spotOut.replaceChildren(el('p', { class: 'icm-msg error', text: 'Fix the players and payouts above first.' }));
        return;
      }
    }
    try {
      const blinds = { sb: readNumber(sbInput) ?? 0, bb: readNumber(bbInput) ?? 0, ante: readNumber(anteInput) ?? 0, bbAnte: !!spot.bbAnte };
      const base = {
        stacks: m.stacks,
        payouts: m.payouts,
        blinds,
        sbSeat: spot.sbSeat >= 0 ? spot.sbSeat : undefined,
        bbSeat: spot.bbSeat >= 0 ? spot.bbSeat : undefined,
        hero: spot.hero,
        villain: spot.villain,
        action: spot.action,
      };
      let inputs;
      try {
        inputs = spotInputs();
        if (spot.mode === 'range') {
          eqInfo.className = 'icm-msg';
          eqInfo.textContent = inputs.missing
            ? inputs.missing + (spot.action === 'jam' ? ` · villain calls ${pct(1 - inputs.foldFreq, 1)}` : '')
            : `Hero equity ${pct(inputs.equity)} (tie ${pct(inputs.tie)})` +
              (spot.action === 'jam' ? ` · villain calls ${pct(1 - inputs.foldFreq, 1)}` : '');
        }
      } catch (err) {
        eqInfo.className = 'icm-msg error';
        eqInfo.textContent = err.message;
        inputs = { missing: err.message, foldFreq: 0 };
      }
      const probs = { tie: inputs.tie ?? 0, foldFreq: inputs.foldFreq ?? 0 };
      const plain = { ...base, ...probs };
      const withPko = spot.pko
        ? { ...plain, bounties: m.bounties, pko: { headValueFactor: readNumber(hvfInput) ?? 0 } }
        : plain;
      const chipReq = chipRequiredEquity(plain);
      const icmReq = icmRequiredEquity(plain);
      const stats = [
        stat('Chip-EV required equity', requiredText(chipReq)),
        stat('ICM required equity', requiredText(icmReq)),
        stat('Risk premium', chipReq === null || icmReq === null ? '–' : `${signed((icmReq - chipReq) * 100, 1)} pts`),
      ];
      if (spot.pko) stats.push(stat('ICM + PKO required equity', requiredText(icmRequiredEquity(withPko)), 'pko'));
      const children = [el('div', { class: 'stats' }, stats)];

      if (inputs.equity === undefined) {
        children.push(el('p', { class: 'muted', text: `${inputs.missing} to see the $EV of the decision.` }));
      } else {
        const r = spotEV({ ...withPko, equity: inputs.equity });
        const label = spot.action === 'jam' ? 'Jam' : 'Call';
        const good = r.diff > 1e-9;
        children.push(
          el('div', { class: 'stats' }, [
            stat('$EV fold', money(r.foldEV)),
            stat(`$EV ${label.toLowerCase()}`, money(r.actionEV)),
            stat('Difference', `${r.diff >= 0 ? '+' : '−'}${money(Math.abs(r.diff))}`, good ? 'good' : 'bad'),
          ]),
          el('div', { class: `badge ${good ? 'good' : 'bad'}`, text: good ? `+$EV: ${label.toLowerCase()}` : '−$EV: fold' }),
          el('p', {
            class: 'muted small',
            text: `Chip EV of the ${label.toLowerCase()}: ${signed(r.chips.diff)} chips vs folding.`,
          }),
        );
      }
      spotOut.replaceChildren(...children);
    } catch (err) {
      spotOut.replaceChildren(el('p', { class: 'icm-msg error', text: err.message }));
    }
  }

  // -- layout -------------------------------------------------------------

  const section = el('section', { class: 'icm-tab' }, [
    el('h2', { text: 'ICM' }),
    el('p', {
      class: 'muted',
      text: 'Malmuth-Harville $EV from stacks and payouts. Enter only the players still in (2–10).',
    }),
    el('div', { class: 'icm-layout' }, [
      el('div', { class: 'panel' }, [el('h3', { text: 'Players' }), playersEl, addBtn]),
      el('div', { class: 'panel' }, [
        el('h3', { text: 'Payouts' }),
        payoutsEditor.element,
      ]),
      el('div', { class: 'panel wide' }, [el('h3', { text: 'Results' }), resultsMsg, resultsEl]),
      el('div', { class: 'panel wide' }, [
        el('h3', { text: 'Spot' }),
        el('div', { class: 'icm-row' }, [field('Hero', heroSelect), field('Villain', villainSelect), field('Action', actionSelect)]),
        el('div', { class: 'icm-row' }, [
          field('SB', sbInput),
          field('BB', bbInput),
          field('Ante', anteInput),
          spotCheck('bbAnte', 'BB ante'),
          field('SB seat', sbSelect),
          field('BB seat', bbSelect),
        ]),
        el('div', { class: 'icm-row' }, modeRadios),
        rangeRow,
        eqInfo,
        manualRow,
        pkoRow,
        spotOut,
      ]),
    ]),
  ]);
  root.append(section);

  function changed() {
    persist();
    let m = null;
    try {
      m = model();
      resultsMsg.textContent = '';
      payoutsEditor.setMessage('');
      updateResults(m);
    } catch (err) {
      const isPayout = /payout|prize pool/i.test(err.message);
      resultsMsg.textContent = isPayout ? '' : err.message;
      payoutsEditor.setMessage(isPayout ? err.message : '');
      resultsEl.replaceChildren();
    }
    updateSpot(m);
  }

  buildPlayers();
  refreshSeats();
  changed();
}
