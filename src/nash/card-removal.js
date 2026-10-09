// Card removal between hand classes and the class-vs-class equity lookup.
//
// compatiblePairs[a][b] (flat: PAIRS[a * 169 + b]) is the number of (combo of a,
// combo of b) pairs that share no card, with classes in handClasses() grid order.
// When hero holds class a, villain's class b is weighted by PAIRS[a][b] rather than
// b's raw combo count. Each row sums to combos(a) * 1225 (= C(50, 2) per combo).
//
// The preflop table's class-vs-class equity is already averaged over exactly these
// compatible combo pairs, so PAIRS[a][b] * eq(a, b) is the summed equity over pairs.

import { handClasses, classComboCount } from '../engine/ranges.js';
import { CLASS_COMBOS, COMBO_CARDS } from '../engine/combos.js';
import { preflopEquity, loadPreflopTable } from '../engine/equity.js';

export const N_CLASSES = 169;
/** Combos per class: 6 pairs, 4 suited, 12 offsuit. */
export const CLASS_COMBO_COUNTS = Uint8Array.from(handClasses(), classComboCount);
/** All ordered (hero combo, villain combo) pairs that share no card: 1326 * 1225. */
export const TOTAL_PAIRS = 1326 * 1225;

/** Flat 169x169 matrix of compatible combo pairs. */
export const PAIRS = new Float64Array(N_CLASSES * N_CLASSES);
for (let a = 0; a < N_CLASSES; a++) {
  for (let b = 0; b < N_CLASSES; b++) {
    let count = 0;
    for (const i of CLASS_COMBOS[a]) {
      const c1 = COMBO_CARDS[2 * i];
      const c2 = COMBO_CARDS[2 * i + 1];
      for (const j of CLASS_COMBOS[b]) {
        const d1 = COMBO_CARDS[2 * j];
        const d2 = COMBO_CARDS[2 * j + 1];
        if (c1 !== d1 && c1 !== d2 && c2 !== d1 && c2 !== d2) count++;
      }
    }
    PAIRS[a * N_CLASSES + b] = count;
  }
}

/** compatiblePairs[a][b] as nested arrays (convenient for inspection; PAIRS is faster). */
export const compatiblePairs = Array.from({ length: N_CLASSES }, (_, a) =>
  Array.from(PAIRS.subarray(a * N_CLASSES, (a + 1) * N_CLASSES)),
);

/** Compatible combo pairs between class indices a and b. */
export function pairs(a, b) {
  return PAIRS[a * N_CLASSES + b];
}

let equities = null;

/**
 * Flat 169x169 matrix of preflop all-in equity (row class vs column class), built once
 * from data/preflop-equity-169.json. In Node the table is read from disk on first use;
 * in a browser or worker call `await ensureEquityTable()` first.
 */
export function equityMatrix() {
  if (equities) return equities;
  const classes = handClasses();
  if (preflopEquity(classes[0], classes[1]) === null) {
    throw new Error('Preflop equity table is not loaded: run npm run build:equity, or await ensureEquityTable() in the browser');
  }
  const m = new Float64Array(N_CLASSES * N_CLASSES);
  for (let a = 0; a < N_CLASSES; a++) {
    for (let b = 0; b < N_CLASSES; b++) m[a * N_CLASSES + b] = preflopEquity(classes[a], classes[b]);
  }
  equities = m;
  return m;
}

/** Equity of class index a vs class index b from the preflop table. */
export function eq(a, b) {
  return equityMatrix()[a * N_CLASSES + b];
}

/** Loads the preflop table where a synchronous read is not possible (browser, worker). */
export async function ensureEquityTable() {
  if (equities) return;
  await loadPreflopTable();
  equityMatrix();
}
