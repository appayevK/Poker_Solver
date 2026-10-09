// Expanding hand classes into specific combos, with card removal.
//
// Each of the 1326 two-card combos has an index: for cards hi > lo,
// comboIndex = hi * (hi - 1) / 2 + lo.

import { parseCards } from './cards.js';
import { handClasses, classIndex, classInfo, toRange, isComboKey, comboKeyCards, comboClass } from './ranges.js';

const CLASSES = handClasses();

/** Index 0..1325 of the combo made of two different cards (any order). */
export function comboIndex(c1, c2) {
  const hi = c1 > c2 ? c1 : c2;
  const lo = c1 > c2 ? c2 : c1;
  return (hi * (hi - 1)) / 2 + lo;
}

/** COMBO_CARDS[2i], COMBO_CARDS[2i+1] = higher and lower card of combo i. */
export const COMBO_CARDS = new Uint8Array(2652);
/** Grid class index (0..168) of each combo. */
export const COMBO_CLASS = new Uint8Array(1326);
/** Combo indices per class, in suit order s, h, d, c (higher card first). */
export const CLASS_COMBOS = [];

for (let hi = 1; hi < 52; hi++) {
  for (let lo = 0; lo < hi; lo++) {
    const i = comboIndex(hi, lo);
    COMBO_CARDS[2 * i] = hi;
    COMBO_CARDS[2 * i + 1] = lo;
    COMBO_CLASS[i] = classIndex(comboClass(hi, lo));
  }
}

for (const cls of CLASSES) {
  const { hi, lo, type } = classInfo(cls);
  const list = [];
  for (let s1 = 3; s1 >= 0; s1--) {
    for (let s2 = 3; s2 >= 0; s2--) {
      if (type === 'pair' ? s2 >= s1 : type === 'suited' ? s2 !== s1 : s2 === s1) continue;
      list.push(comboIndex(hi * 4 + s1, lo * 4 + s2));
    }
  }
  CLASS_COMBOS.push(Uint16Array.from(list));
}

function deadFlags(dead) {
  const flags = new Uint8Array(52);
  for (const c of typeof dead === 'string' ? parseCards(dead) : dead) flags[c] = 1;
  return flags;
}

/** 'AKs' → [[As,Ks],[Ah,Kh],...] (card indices, higher card first) excluding dead cards. */
export function combosForClass(handClass, dead = []) {
  const ci = classIndex(handClass);
  if (ci < 0) throw new Error(`Unknown hand class "${handClass}"`);
  const flags = deadFlags(dead);
  const out = [];
  for (const i of CLASS_COMBOS[ci]) {
    const a = COMBO_CARDS[2 * i];
    const b = COMBO_CARDS[2 * i + 1];
    if (!flags[a] && !flags[b]) out.push([a, b]);
  }
  return out;
}

/** Effective weight of every combo in a range (Map or notation), indexed by comboIndex. */
export function comboWeights(range) {
  const r = toRange(range);
  const w = new Float64Array(1326);
  for (const [key, weight] of r) {
    if (isComboKey(key)) continue;
    const ci = classIndex(key);
    if (ci < 0) throw new Error(`Unknown hand class "${key}"`);
    for (const i of CLASS_COMBOS[ci]) w[i] = weight;
  }
  for (const [key, weight] of r) {
    if (!isComboKey(key)) continue;
    const [a, b] = comboKeyCards(key);
    w[comboIndex(a, b)] = weight;
  }
  return w;
}

/**
 * Expand a weighted range into weighted combos, removing blocked ones:
 * [{ cards: [c1, c2], weight }] in grid order, zero-weight combos omitted.
 */
export function expandRange(range, dead = []) {
  const w = comboWeights(range);
  const flags = deadFlags(dead);
  const out = [];
  for (let ci = 0; ci < 169; ci++) {
    for (const i of CLASS_COMBOS[ci]) {
      const a = COMBO_CARDS[2 * i];
      const b = COMBO_CARDS[2 * i + 1];
      if (w[i] > 0 && !flags[a] && !flags[b]) out.push({ cards: [a, b], weight: w[i] });
    }
  }
  return out;
}

/** Weighted combo count after card removal. */
export function countCombos(range, dead = []) {
  let total = 0;
  for (const { weight } of expandRange(range, dead)) total += weight;
  return total;
}

