// Preflop cash charts: load, edit, save. Presets in data/charts/.
//
// Chart format
//   { id, name, notes, stack: 100, players: 6, sizes, spots }
// - sizes: default raise sizes shown in the UI and used by the range checks:
//     { open: 2.5, sbOpen: 3 }          open-raise to, in bb
//     { threeBetIP: 3, threeBetOOP: 4 } 3-bet to, as a multiple of the open
//     { fourBet: 2.2 }                  4-bet to, as a multiple of the 3-bet
// - spots: keyed by spot id, positions in 6-max action order UTG, HJ, CO, BTN, SB, BB:
//     "RFI:CO"           CO first in (raise first in)
//     "vsOpen:BB:BTN"    BB facing a BTN open (hero first, then the opener)
//     "vs3bet:CO:BTN"    CO opened and the BTN 3-bet (hero first, then the 3-bettor)
//   Each spot maps actions to range strings in the usual notation, with optional
//   weights for mixed strategies ("A5s:0.5"):
//     { raise: "...", call: "...", allin?: "..." }
//   raise means open / 3-bet / 4-bet depending on the spot; call in an RFI spot is a
//   limp. Fold is whatever frequency is left over for each hand.

import baseline from '../../data/charts/cash-6max-100bb.json';
import { handClasses, parseRange, rangeToString, classIndex } from '../engine/ranges.js';
import { comboWeights, comboIndex, CLASS_COMBOS } from '../engine/combos.js';
import { parseCards } from '../engine/cards.js';
import { load, save } from '../storage/store.js';

export const POSITIONS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
export const ACTIONS = ['raise', 'call', 'allin'];
export const ALL_ACTIONS = ['raise', 'call', 'allin', 'fold'];
export const SPOT_TYPES = ['RFI', 'vsOpen', 'vs3bet'];
export const BASELINE_ID = baseline.id;

const CLASSES = handClasses();
const INDEX_KEY = 'charts:index';
const chartKey = (id) => `chart:${id}`;
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Spot ids

/** 'vsOpen:BB:BTN' → { type: 'vsOpen', hero: 'BB', villain: 'BTN' }; null if malformed. */
export function parseSpotId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  const [type, hero, villain] = parts;
  if (type === 'RFI' && parts.length === 2) return { type, hero, villain: null };
  if ((type === 'vsOpen' || type === 'vs3bet') && parts.length === 3) return { type, hero, villain };
  return null;
}

/** Problem with a spot id's positions, or '' if it is a valid 6-max spot. */
export function spotIdProblem(id) {
  const spot = parseSpotId(id);
  if (!spot) return `"${id}" is not a spot id (use RFI:POS, vsOpen:HERO:OPENER or vs3bet:HERO:3BETTOR)`;
  const h = POSITIONS.indexOf(spot.hero);
  if (h < 0) return `"${id}": unknown position ${spot.hero}`;
  if (spot.type === 'RFI') return spot.hero === 'BB' ? `"${id}": the BB cannot open (everyone folded to it)` : '';
  const v = POSITIONS.indexOf(spot.villain);
  if (v < 0) return `"${id}": unknown position ${spot.villain}`;
  if (spot.type === 'vsOpen') {
    if (spot.villain === 'BB') return `"${id}": the BB cannot open`;
    if (v >= h) return `"${id}": the opener ${spot.villain} must act before ${spot.hero}`;
    return '';
  }
  if (spot.hero === 'BB') return `"${id}": the BB cannot open, so it cannot face a 3-bet as the opener`;
  if (v <= h) return `"${id}": the 3-bettor ${spot.villain} must act after the opener ${spot.hero}`;
  return '';
}

/** Every valid 6-max spot id, in a stable order. */
export function allSpotIds() {
  const ids = [];
  for (const hero of POSITIONS.slice(0, 5)) ids.push(`RFI:${hero}`);
  for (let o = 0; o < 5; o++) for (let h = o + 1; h < 6; h++) ids.push(`vsOpen:${POSITIONS[h]}:${POSITIONS[o]}`);
  for (let o = 0; o < 5; o++) for (let t = o + 1; t < 6; t++) ids.push(`vs3bet:${POSITIONS[o]}:${POSITIONS[t]}`);
  return ids;
}

/** Plain-language description: 'CO facing a UTG open'. */
export function describeSpot(id) {
  const s = parseSpotId(id);
  if (!s) return id;
  if (s.type === 'RFI') return `${s.hero} first in`;
  if (s.type === 'vsOpen') return `${s.hero} facing a ${s.villain} open`;
  return `${s.hero} opened, ${s.villain} 3-bets`;
}

/** Names of the aggressive action in a spot: open / 3-bet / 4-bet. */
export function raiseLabel(id) {
  const type = parseSpotId(id)?.type;
  return type === 'RFI' ? 'Open' : type === 'vsOpen' ? '3-bet' : '4-bet';
}

/** Actions a player may choose in a spot: fold and raise always, call and all-in when the chart uses them (call is always legal facing a raise). */
export function legalActions(chart, id) {
  const s = parseSpotId(id);
  const spot = chart.spots[id] ?? {};
  const out = ['fold'];
  if (s.type !== 'RFI' || spot.call) out.push('call');
  out.push('raise');
  if (spot.allin) out.push('allin');
  return out;
}

// ---------------------------------------------------------------------------
// Frequencies

/** Per-combo frequency vectors (Float64Array(1326)) of every action in a spot. */
function comboFrequencies(chart, id) {
  const spot = chart.spots[id];
  if (!spot) throw new Error(`Chart "${chart.name}" has no spot ${id}`);
  const out = {};
  for (const action of ACTIONS) out[action] = comboWeights(spot[action] ? parseRange(spot[action]) : new Map());
  return out;
}

/** Class-level frequencies { raise, call, allin, fold }, each a Float64Array(169) (averaged over combos). */
export function spotFrequencies(chart, id) {
  const combos = comboFrequencies(chart, id);
  const out = { raise: new Float64Array(169), call: new Float64Array(169), allin: new Float64Array(169), fold: new Float64Array(169) };
  for (let c = 0; c < 169; c++) {
    let rest = 1;
    for (const action of ACTIONS) {
      let sum = 0;
      for (const i of CLASS_COMBOS[c]) sum += combos[action][i];
      out[action][c] = sum / CLASS_COMBOS[c].length;
      rest -= out[action][c];
    }
    out.fold[c] = Math.max(0, rest);
  }
  return out;
}

/**
 * Frequencies of every action for a hand in a spot: { raise, call, allin, fold },
 * summing to 1. handClass is a class ('A5s') or exact cards ('As5s', for combo
 * overrides).
 */
export function chartAction(chart, id, handClass) {
  const ci = classIndex(handClass);
  const result = {};
  let rest = 1;
  if (ci >= 0) {
    const freqs = spotFrequencies(chart, id);
    for (const action of ACTIONS) result[action] = freqs[action][ci];
  } else {
    const cards = parseCards(handClass);
    if (cards.length !== 2) throw new Error(`"${handClass}" is not a hand class or two cards`);
    const combos = comboFrequencies(chart, id);
    const i = comboIndex(cards[0], cards[1]);
    for (const action of ACTIONS) result[action] = combos[action][i];
  }
  for (const action of ACTIONS) rest -= result[action];
  result.fold = Math.max(0, rest);
  return result;
}

/** Range Map for one action in a spot. 'fold' gives the class-level remainder. */
export function spotRange(chart, id, action) {
  if (action === 'fold') {
    const fold = spotFrequencies(chart, id).fold;
    const range = new Map();
    for (let c = 0; c < 169; c++) if (fold[c] > EPS) range.set(CLASSES[c], Math.round(fold[c] * 1e6) / 1e6);
    return range;
  }
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action "${action}"`);
  const text = chart.spots[id]?.[action];
  return text ? parseRange(text) : new Map();
}

/** Range Map of every hand that continues (raise + call + all-in), class level. */
export function continueRange(chart, id) {
  const f = spotFrequencies(chart, id);
  const range = new Map();
  for (let c = 0; c < 169; c++) {
    const w = Math.min(1, f.raise[c] + f.call[c] + f.allin[c]);
    if (w > EPS) range.set(CLASSES[c], Math.round(w * 1e6) / 1e6);
  }
  return range;
}

/** Classes whose frequencies differ between two charts in a spot: [{ handClass, a, b }]. */
export function diffCharts(a, b, id) {
  const empty = { spots: { [id]: {} } };
  const fa = spotFrequencies(a.spots[id] ? a : empty, id);
  const fb = spotFrequencies(b.spots[id] ? b : empty, id);
  const out = [];
  for (let c = 0; c < 169; c++) {
    if (ALL_ACTIONS.some((action) => Math.abs(fa[action][c] - fb[action][c]) > EPS)) {
      const pick = (f) => Object.fromEntries(ALL_ACTIONS.map((action) => [action, f[action][c]]));
      out.push({ handClass: CLASSES[c], a: pick(fa), b: pick(fb) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation

/**
 * Checks a chart and returns a list of problems (empty when valid): shape, spot ids,
 * range strings, and action frequencies summing to at most 1 per hand. Charts with
 * problems cannot be saved. See chartWarnings for consistency between spots.
 */
export function validateChart(chart) {
  const problems = [];
  if (!chart || typeof chart !== 'object') return ['Chart must be an object'];
  if (typeof chart.id !== 'string' || !chart.id) problems.push('Chart needs an id');
  if (typeof chart.name !== 'string' || !chart.name.trim()) problems.push('Chart needs a name');
  if (chart.players !== 6) problems.push('Only 6-max charts are supported (players: 6)');
  if (typeof chart.stack !== 'number' || chart.stack <= 0) problems.push('stack must be a positive number of big blinds');
  if (!chart.sizes || typeof chart.sizes !== 'object') problems.push('Chart needs sizes');
  else {
    for (const key of ['open', 'sbOpen', 'threeBetIP', 'threeBetOOP', 'fourBet']) {
      if (!(typeof chart.sizes[key] === 'number' && chart.sizes[key] > 0)) problems.push(`sizes.${key} must be a positive number`);
    }
  }
  if (!chart.spots || typeof chart.spots !== 'object') return problems.concat('Chart needs spots');

  const parsedOk = new Set();
  for (const [id, spot] of Object.entries(chart.spots)) {
    const idProblem = spotIdProblem(id);
    if (idProblem) {
      problems.push(idProblem);
      continue;
    }
    if (!spot || typeof spot !== 'object') {
      problems.push(`${id}: must map actions to range strings`);
      continue;
    }
    let ok = true;
    for (const [action, text] of Object.entries(spot)) {
      if (!ACTIONS.includes(action)) {
        problems.push(`${id}: unknown action "${action}" (use raise, call, allin; fold is the rest)`);
        ok = false;
        continue;
      }
      if (typeof text !== 'string') {
        problems.push(`${id}.${action}: must be a range string`);
        ok = false;
        continue;
      }
      try {
        parseRange(text);
      } catch (err) {
        problems.push(`${id}.${action}: ${err.message}`);
        ok = false;
      }
    }
    if (!ok) continue;
    parsedOk.add(id);
    const combos = comboFrequencies(chart, id);
    const over = new Set();
    for (let i = 0; i < 1326; i++) {
      const sum = combos.raise[i] + combos.call[i] + combos.allin[i];
      if (sum > 1 + EPS) over.add(comboClassOf(i));
    }
    if (over.size) problems.push(`${id}: frequencies add up to more than 1 for ${[...over].join(', ')}`);
  }
  return problems;
}

/**
 * Consistency notes that do not stop a chart from being saved: an opener facing a
 * 3-bet should only continue with hands it opens. Returns a list of messages.
 */
export function chartWarnings(chart) {
  const problems = [];
  const parsedOk = new Set(Object.keys(chart.spots ?? {}).filter((id) => !spotIdProblem(id)));
  for (const id of parsedOk) {
    const s = parseSpotId(id);
    if (s.type !== 'vs3bet' || !parsedOk.has(`RFI:${s.hero}`)) continue;
    let opens;
    let cont;
    try {
      opens = spotFrequencies(chart, `RFI:${s.hero}`);
      cont = spotFrequencies(chart, id);
    } catch {
      continue; // unparsable ranges are reported by validateChart
    }
    const extra = [];
    for (let c = 0; c < 169; c++) {
      const opened = opens.raise[c] + opens.call[c] + opens.allin[c];
      const continued = cont.raise[c] + cont.call[c] + cont.allin[c];
      if (continued > opened + 1e-6) extra.push(CLASSES[c]);
    }
    if (extra.length) problems.push(`${id}: continues vs the 3-bet with hands ${s.hero} does not open (${extra.join(', ')})`);
  }
  return problems;
}

function comboClassOf(i) {
  for (let c = 0; c < 169; c++) if (CLASS_COMBOS[c].includes(i)) return CLASSES[c];
  return '?';
}

// ---------------------------------------------------------------------------
// Storage: the built-in baseline plus charts saved in localStorage.

const clone = (x) => JSON.parse(JSON.stringify(x));

/** [{ id, name, builtIn }] - the baseline first, then saved charts. */
export function listCharts() {
  const saved = load(INDEX_KEY, []);
  return [{ id: baseline.id, name: baseline.name, builtIn: true }, ...saved.map((x) => ({ ...x, builtIn: false }))];
}

/** A copy of a built-in or saved chart, or null. */
export function loadChart(id = BASELINE_ID) {
  if (id === baseline.id) return clone(baseline);
  const chart = load(chartKey(id), null);
  return chart ? clone(chart) : null;
}

/** True for charts shipped with the app (read-only). */
export function isBuiltIn(id) {
  return id === baseline.id;
}

/** Saves a chart (not the built-in id). Throws when the chart has problems. */
export function saveChart(chart) {
  if (isBuiltIn(chart.id)) throw new Error('The built-in baseline is read-only; duplicate it first');
  const problems = validateChart(chart);
  if (problems.length) throw new Error(`Chart has problems: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`);
  save(chartKey(chart.id), chart);
  const index = load(INDEX_KEY, []).filter((x) => x.id !== chart.id);
  index.push({ id: chart.id, name: chart.name });
  save(INDEX_KEY, index);
  return chart;
}

/** Removes a saved chart. */
export function deleteChart(id) {
  if (isBuiltIn(id)) throw new Error('The built-in baseline cannot be deleted');
  try {
    localStorage.removeItem(chartKey(id));
  } catch {
    // storage unavailable
  }
  save(
    INDEX_KEY,
    load(INDEX_KEY, []).filter((x) => x.id !== id),
  );
}

function newId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `chart-${Date.now().toString(36)}-${rand}`;
}

/** A copy of a chart with a new id and name (not saved yet). */
export function duplicateChart(chart, { name } = {}) {
  const copy = clone(chart);
  copy.id = newId();
  copy.name = name ?? `${chart.name} (copy)`;
  return copy;
}

/** Sets one action's range in a spot (in place) from a range Map or string. */
export function setSpotAction(chart, id, action, range) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action "${action}"`);
  chart.spots[id] ??= {};
  const text = typeof range === 'string' ? rangeToString(parseRange(range)) : rangeToString(range);
  if (text) chart.spots[id][action] = text;
  else delete chart.spots[id][action];
  return chart;
}
