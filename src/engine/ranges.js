// Range parsing and representation.
//
// A range is a Map from keys to weights in 0..1:
//   - hand classes ('AKs', 'QQ', 'T9o') → weight of every combo in the class
//   - specific combos ('AsKs', 4 characters, higher card first) → weight of that
//     one combo, overriding its class weight (e.g. 'AKs, AsKs:0' = AKs minus AsKs)
// Classes with weight 0 are omitted. A combo key is only stored when it differs
// from its class weight. Setting a class clears the combo overrides inside it.

import { RANKS, parseCard, cardToString } from './cards.js';

/** Rank order of grid rows/columns. */
export const GRID_RANKS = 'AKQJT98765432';

/** Class name from two rank indices (0..12 = 2..A, any order). */
export function className(r1, r2, suited) {
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  if (hi === lo) return RANKS[hi] + RANKS[hi];
  return RANKS[hi] + RANKS[lo] + (suited ? 's' : 'o');
}

/** Class at grid row/col (0 = Ace): pairs on the diagonal, suited above, offsuit below. */
export function classAt(row, col) {
  const a = 12 - row;
  const b = 12 - col;
  return className(a, b, col > row);
}

const CLASSES = [];
for (let row = 0; row < 13; row++) for (let col = 0; col < 13; col++) CLASSES.push(classAt(row, col));
Object.freeze(CLASSES);

const CLASS_INDEX = new Map(CLASSES.map((c, i) => [c, i]));

/** All 169 hand classes in grid order (row = first rank, col = second rank, A..2). */
export function handClasses() {
  return CLASSES.slice();
}

/** Grid index 0..168 of a class name, or -1. */
export function classIndex(cls) {
  return CLASS_INDEX.get(cls) ?? -1;
}

/** { hi, lo, type } for a class name; ranks are 0..12 (2..A). */
export function classInfo(cls) {
  if (!CLASS_INDEX.has(cls)) throw new Error(`Unknown hand class "${cls}"`);
  const hi = RANKS.indexOf(cls[0]);
  const lo = RANKS.indexOf(cls[1]);
  const type = hi === lo ? 'pair' : cls[2] === 's' ? 'suited' : 'offsuit';
  return { hi, lo, type };
}

/** Number of combos in a class: 6 pairs, 4 suited, 12 offsuit. */
export function classComboCount(cls) {
  return cls.length === 2 ? 6 : cls[2] === 's' ? 4 : 12;
}

/** True for a specific-combo key like 'AsKs'. */
export function isComboKey(key) {
  return key.length === 4;
}

/** Canonical combo key, higher card first: (45, 51) → 'AsKd'. */
export function comboKey(c1, c2) {
  if (c1 === c2) throw new Error(`Combo needs two different cards, got ${cardToString(c1)} twice`);
  return c1 > c2 ? cardToString(c1) + cardToString(c2) : cardToString(c2) + cardToString(c1);
}

/** 'AsKd' → [51, 45] */
export function comboKeyCards(key) {
  return [parseCard(key.slice(0, 2)), parseCard(key.slice(2, 4))];
}

/** Class of a combo given as two card indices: (51, 47) → 'AKs'. */
export function comboClass(c1, c2) {
  return className(c1 >> 2, c2 >> 2, (c1 & 3) === (c2 & 3));
}

/** Class of a combo key: 'AsKs' → 'AKs'. */
export function comboKeyClass(key) {
  const [a, b] = comboKeyCards(key);
  return comboClass(a, b);
}

/** Effective weight of a combo in a range (override if present, else class weight). */
export function comboWeight(range, c1, c2) {
  const w = range.get(comboKey(c1, c2));
  return w !== undefined ? w : range.get(comboClass(c1, c2)) ?? 0;
}

/** Sets a class weight in place, clearing combo overrides inside the class. */
export function setClassWeight(range, cls, weight) {
  if (!CLASS_INDEX.has(cls)) throw new Error(`Unknown hand class "${cls}"`);
  checkWeight(weight, cls);
  for (const key of [...range.keys()]) {
    if (isComboKey(key) && comboKeyClass(key) === cls) range.delete(key);
  }
  if (weight > 0) range.set(cls, weight);
  else range.delete(cls);
  return range;
}

/** Sets one combo's weight in place (stored only if it differs from the class weight). */
export function setComboWeight(range, c1, c2, weight) {
  checkWeight(weight, comboKey(c1, c2));
  const key = comboKey(c1, c2);
  if (weight === (range.get(comboClass(c1, c2)) ?? 0)) range.delete(key);
  else range.set(key, weight);
  return range;
}

function checkWeight(w, what) {
  if (typeof w !== 'number' || !(w >= 0 && w <= 1)) {
    throw new Error(`Weight for ${what} must be between 0 and 1, got ${w}`);
  }
}

// ---------------------------------------------------------------------------
// Parsing

const R = '[2-9TJQKA]';
const COMBO_RE = new RegExp(`^(${R}[cdhs])(${R}[cdhs])$`, 'i');
const SINGLE_RE = new RegExp(`^(${R})(${R})([so]?)(\\+?)$`, 'i');
const DASH_RE = new RegExp(`^(${R})(${R})([so]?)-(${R})(${R})([so]?)$`, 'i');

function rank(ch) {
  return RANKS.indexOf(ch.toUpperCase());
}

function parseWeight(str, token) {
  let s = str;
  let scale = 1;
  if (s.endsWith('%')) {
    s = s.slice(0, -1);
    scale = 100;
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) throw new Error(`Invalid weight in "${token}"`);
  const w = Number(s) / scale;
  if (!(w >= 0 && w <= 1)) throw new Error(`Weight in "${token}" must be between 0 and 1`);
  return w;
}

/** Classes for a non-pair (hi, lo) with suffix 's', 'o' or '' (both). */
function pushNonPair(out, hi, lo, suffix) {
  if (suffix !== 'o') out.push(className(hi, lo, true));
  if (suffix !== 's') out.push(className(hi, lo, false));
}

function expandClassToken(body, token) {
  let m = SINGLE_RE.exec(body);
  if (m) {
    const a = rank(m[1]);
    const b = rank(m[2]);
    const suffix = m[3].toLowerCase();
    const plus = m[4] === '+';
    const out = [];
    if (a === b) {
      if (suffix) throw new Error(`Pairs cannot be suited or offsuit: "${token}"`);
      for (let r = a; r <= (plus ? 12 : a); r++) out.push(className(r, r));
      return out;
    }
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    for (let k = lo; k <= (plus ? hi - 1 : lo); k++) pushNonPair(out, hi, k, suffix);
    return out;
  }

  m = DASH_RE.exec(body);
  if (m) {
    const s1 = m[3].toLowerCase();
    const s2 = m[6].toLowerCase();
    if (s1 && s2 && s1 !== s2) throw new Error(`Mismatched suffixes in "${token}"`);
    const suffix = s1 || s2;
    let [h1, l1] = [rank(m[1]), rank(m[2])].sort((x, y) => y - x);
    let [h2, l2] = [rank(m[4]), rank(m[5])].sort((x, y) => y - x);
    if (h1 < h2 || (h1 === h2 && l1 < l2)) [h1, l1, h2, l2] = [h2, l2, h1, l1]; // first end = higher
    const out = [];
    const pair1 = h1 === l1;
    const pair2 = h2 === l2;
    if (pair1 || pair2) {
      if (!(pair1 && pair2)) throw new Error(`Cannot mix pairs and non-pairs in "${token}"`);
      if (suffix) throw new Error(`Pairs cannot be suited or offsuit: "${token}"`);
      for (let r = h2; r <= h1; r++) out.push(className(r, r));
      return out;
    }
    if (h1 === h2) {
      for (let k = l2; k <= l1; k++) pushNonPair(out, h1, k, suffix);
      return out;
    }
    if (h1 - l1 === h2 - l2) {
      for (let d = 0; d <= h1 - h2; d++) pushNonPair(out, h2 + d, l2 + d, suffix);
      return out;
    }
    throw new Error(`Dash range "${token}" must keep the top card or the gap fixed (e.g. A5s-A2s, T9s-65s)`);
  }
  throw new Error(`Cannot parse "${token}"`);
}

function applyToken(range, token) {
  let body = token;
  let weight = 1;
  const colon = token.indexOf(':');
  if (colon >= 0) {
    body = token.slice(0, colon);
    weight = parseWeight(token.slice(colon + 1), token);
  }
  const combo = COMBO_RE.exec(body);
  if (combo) {
    const a = parseCard(combo[1]);
    const b = parseCard(combo[2]);
    if (a === b) throw new Error(`Combo "${token}" repeats a card`);
    setComboWeight(range, a, b, weight);
    return;
  }
  for (const cls of expandClassToken(body, token)) setClassWeight(range, cls, weight);
}

/**
 * '22+, A2s+, KTo+, 76s:0.5, AsKs' → Map.
 * Supports pairs (QQ, QQ+, QQ-99), suited/offsuit/both (AKs, AKo, AK), plus ranges
 * (A2s+, KTo+), dash ranges (T9s-65s, A5s-A2s), weights (A5s:0.5 or A5s:50%) and
 * specific combos (AsKs). Separators: commas, semicolons or whitespace. Later
 * tokens override earlier ones.
 */
export function parseRange(str) {
  const range = new Map();
  if (str == null) return range;
  const text = String(str)
    .replace(/\s+\+/g, '+')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s*:\s*/g, ':')
    .trim();
  if (!text) return range;
  for (const token of text.split(/[\s,;]+/)) {
    if (token) applyToken(range, token);
  }
  return range;
}

/** Accepts a range Map (returned as is) or notation string. */
export function toRange(input) {
  if (input instanceof Map) return input;
  if (typeof input === 'string') return parseRange(input);
  throw new TypeError('Range must be a Map or a string');
}

// ---------------------------------------------------------------------------
// Formatting

function formatWeight(w) {
  return String(w);
}

/** Runs of consecutive ranks from a descending-sorted list: [[top, bottom], ...] */
function runs(ranksDesc) {
  const out = [];
  for (const r of ranksDesc) {
    const last = out[out.length - 1];
    if (last && last[1] === r + 1) last[1] = r;
    else out.push([r, r]);
  }
  return out;
}

function nonPairToken(hi, [top, bottom], suffix) {
  const H = RANKS[hi];
  if (top === bottom) return H + RANKS[top] + suffix;
  if (top === hi - 1) return H + RANKS[bottom] + suffix + '+';
  return `${H}${RANKS[top]}${suffix}-${H}${RANKS[bottom]}${suffix}`;
}

/** Compact tokens for a set of classes that share one weight. */
function compressClasses(set) {
  const tokens = [];

  const pairs = [];
  for (let r = 12; r >= 0; r--) if (set.has(className(r, r))) pairs.push(r);
  for (const [top, bottom] of runs(pairs)) {
    const P = (r) => RANKS[r] + RANKS[r];
    if (top === bottom) tokens.push(P(top));
    else if (top === 12) tokens.push(P(bottom) + '+');
    else tokens.push(`${P(top)}-${P(bottom)}`);
  }

  // Kicker runs per top card; identical suited and offsuit runs merge into 'AT+'-style tokens.
  const items = []; // { hi, run: [topKicker, bottomKicker], suffix }
  for (let hi = 12; hi >= 1; hi--) {
    const suited = [];
    const offsuit = [];
    for (let lo = hi - 1; lo >= 0; lo--) {
      if (set.has(className(hi, lo, true))) suited.push(lo);
      if (set.has(className(hi, lo, false))) offsuit.push(lo);
    }
    const oRuns = runs(offsuit);
    for (const run of runs(suited)) {
      const i = oRuns.findIndex(([t, b]) => t === run[0] && b === run[1]);
      if (i >= 0) oRuns.splice(i, 1);
      items.push({ hi, run, suffix: i >= 0 ? '' : 's' });
    }
    for (const run of oRuns) items.push({ hi, run, suffix: 'o' });
  }

  // Single classes that form a diagonal with a fixed gap (T9s, 98s, 87s) become 'T9s-87s'.
  const out = [];
  const used = new Set();
  for (const item of items) {
    if (used.has(item)) continue;
    const { hi, run, suffix } = item;
    if (run[0] === run[1]) {
      const gap = hi - run[0];
      const chain = [item];
      for (let h = hi - 1; h - gap >= 0; h--) {
        const next = items.find(
          (x) => !used.has(x) && x.hi === h && x.suffix === suffix && x.run[0] === h - gap && x.run[1] === h - gap,
        );
        if (!next) break;
        chain.push(next);
      }
      if (chain.length >= 3) {
        chain.forEach((x) => used.add(x));
        const last = chain[chain.length - 1];
        out.push({
          suffix,
          token: `${RANKS[hi]}${RANKS[run[0]]}${suffix}-${RANKS[last.hi]}${RANKS[last.run[0]]}${suffix}`,
        });
        continue;
      }
    }
    used.add(item);
    out.push({ suffix, token: nonPairToken(hi, run, suffix) });
  }
  // Suited and both-ways tokens first, offsuit after.
  for (const { suffix, token } of out) if (suffix !== 'o') tokens.push(token);
  for (const { suffix, token } of out) if (suffix === 'o') tokens.push(token);
  return tokens;
}

/** Map → compact notation string that round-trips through parseRange. */
export function rangeToString(range) {
  const byWeight = new Map();
  const combos = [];
  for (const [key, w] of range) {
    if (isComboKey(key)) combos.push([key, w]);
    else if (w > 0) {
      if (!byWeight.has(w)) byWeight.set(w, new Set());
      byWeight.get(w).add(key);
    }
  }
  const tokens = [];
  for (const w of [...byWeight.keys()].sort((a, b) => b - a)) {
    const suffix = w === 1 ? '' : ':' + formatWeight(w);
    for (const t of compressClasses(byWeight.get(w))) tokens.push(t + suffix);
  }
  combos.sort(([a], [b]) => {
    const ca = classIndex(comboKeyClass(a));
    const cb = classIndex(comboKeyClass(b));
    return ca - cb || comboKeyCards(b)[0] - comboKeyCards(a)[0] || comboKeyCards(b)[1] - comboKeyCards(a)[1];
  });
  for (const [key, w] of combos) tokens.push(w === 1 ? key : `${key}:${formatWeight(w)}`);
  return tokens.join(', ');
}

/** Weighted number of combos in the range (no card removal). */
export function rangeCombos(range) {
  let total = 0;
  for (const [key, w] of range) {
    if (isComboKey(key)) total += w - (range.get(comboKeyClass(key)) ?? 0);
    else if (CLASS_INDEX.has(key)) total += w * classComboCount(key);
  }
  return total;
}

/** Fraction (0..1) of all 1326 combos the range covers: weighted combos / 1326. */
export function rangePercent(range) {
  return rangeCombos(range) / 1326;
}
