// Fast 5-7 card hand evaluator.
// Returns a comparable strength value: higher = better hand, equal = tie.
//
// Strength encoding: category << 20 | kicker bits, category 0 (high card) .. 8 (straight flush).
// Kicker bits only need to order hands within a category:
//   high card, flush     13-bit mask of the five best ranks
//   pair                 pairRank << 13 | mask of the 3 best kickers
//   two pair             highPair << 8 | lowPair << 4 | kicker
//   trips                tripsRank << 13 | mask of the 2 best kickers
//   straight, str. flush top rank + 1 (wheel = 4, broadway = 13)
//   full house           tripsRank << 4 | pairRank
//   quads                quadsRank << 4 | kicker
// Comparing two masks with the same number of bits set as integers compares the
// ranks from the top down, which is exactly kicker order.

export const HIGH_CARD = 0;
export const PAIR = 1;
export const TWO_PAIR = 2;
export const TRIPS = 3;
export const STRAIGHT = 4;
export const FLUSH = 5;
export const FULL_HOUSE = 6;
export const QUADS = 7;
export const STRAIGHT_FLUSH = 8;

export const CATEGORY_NAMES = [
  'High card', 'Pair', 'Two pair', 'Trips', 'Straight', 'Flush', 'Full house', 'Quads', 'Straight flush',
];

// Lookup tables over 13-bit rank masks, built once at module load.
const POPCOUNT = new Uint8Array(8192);
const HIGHEST = new Uint8Array(8192); // index of the highest set bit
const TOP2 = new Uint16Array(8192); // mask keeping the 2 highest bits
const TOP3 = new Uint16Array(8192);
const TOP5 = new Uint16Array(8192);
const STRAIGHT_TOP = new Uint8Array(8192); // top rank + 1 of the best straight, 0 = none

function keepTop(mask, n) {
  let m = mask;
  while (POPCOUNT[m] > n) m &= m - 1; // clear the lowest set bit
  return m;
}

for (let m = 1; m < 8192; m++) {
  POPCOUNT[m] = POPCOUNT[m >> 1] + (m & 1);
  HIGHEST[m] = 31 - Math.clz32(m);
}
for (let m = 1; m < 8192; m++) {
  TOP2[m] = keepTop(m, 2);
  TOP3[m] = keepTop(m, 3);
  TOP5[m] = keepTop(m, 5);
  for (let top = 12; top >= 4; top--) {
    const run = 0x1f << (top - 4);
    if ((m & run) === run) {
      STRAIGHT_TOP[m] = top + 1;
      break;
    }
  }
  if (!STRAIGHT_TOP[m] && (m & 0x100f) === 0x100f) STRAIGHT_TOP[m] = 4; // A-2-3-4-5
}

/**
 * Strength from rank masks: m1..m4 = ranks held at least 1..4 times,
 * flushMask = rank mask of the suit holding 5+ cards (0 if none).
 * Valid for 5-7 cards (with 7 or fewer cards a flush rules out quads and full houses).
 */
function strengthFromMasks(flushMask, m1, m2, m3, m4) {
  if (flushMask) {
    const sf = STRAIGHT_TOP[flushMask];
    if (sf) return (STRAIGHT_FLUSH << 20) | sf;
    return (FLUSH << 20) | TOP5[flushMask];
  }
  if (m4) {
    const q = HIGHEST[m4];
    return (QUADS << 20) | (q << 4) | HIGHEST[m1 & ~(1 << q)];
  }
  if (m3) {
    const t = HIGHEST[m3];
    const rest = m2 & ~(1 << t);
    if (rest) return (FULL_HOUSE << 20) | (t << 4) | HIGHEST[rest];
  }
  const st = STRAIGHT_TOP[m1];
  if (st) return (STRAIGHT << 20) | st;
  if (m3) {
    const t = HIGHEST[m3];
    return (TRIPS << 20) | (t << 13) | TOP2[m1 & ~(1 << t)];
  }
  if (m2) {
    const p1 = HIGHEST[m2];
    const rest = m2 & ~(1 << p1);
    if (rest) {
      const p2 = HIGHEST[rest];
      return (TWO_PAIR << 20) | (p1 << 8) | (p2 << 4) | HIGHEST[m1 & ~((1 << p1) | (1 << p2))];
    }
    return (PAIR << 20) | (p1 << 13) | TOP3[m1 & ~(1 << p1)];
  }
  return (HIGH_CARD << 20) | TOP5[m1];
}

/** Evaluate best 5-card hand out of 5-7 distinct cards (array of card indices). */
export function evaluate(cards) {
  let m1 = 0, m2 = 0, m3 = 0, m4 = 0;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const bit = 1 << (c >> 2);
    m4 |= m3 & bit;
    m3 |= m2 & bit;
    m2 |= m1 & bit;
    m1 |= bit;
    switch (c & 3) {
      case 0: s0 |= bit; break;
      case 1: s1 |= bit; break;
      case 2: s2 |= bit; break;
      default: s3 |= bit;
    }
  }
  let flush = 0;
  if (POPCOUNT[s0] >= 5) flush = s0;
  else if (POPCOUNT[s1] >= 5) flush = s1;
  else if (POPCOUNT[s2] >= 5) flush = s2;
  else if (POPCOUNT[s3] >= 5) flush = s3;
  return strengthFromMasks(flush, m1, m2, m3, m4);
}

/**
 * Evaluates many 2-card holdings against one fixed 5-card board.
 * The board's rank and suit masks are computed once in setBoard(), so each
 * evalHole() call only adds two cards. Used by the equity enumerators.
 */
export class BoardEvaluator {
  constructor() {
    this.m1 = 0;
    this.m2 = 0;
    this.m3 = 0;
    this.m4 = 0;
    this.flushSuit = -1; // suit with 3+ board cards, the only one that can make a flush
    this.flushBase = 0;
  }

  /** board: 5 distinct card indices */
  setBoard(board) {
    let m1 = 0, m2 = 0, m3 = 0, m4 = 0;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let i = 0; i < 5; i++) {
      const c = board[i];
      const bit = 1 << (c >> 2);
      m4 |= m3 & bit;
      m3 |= m2 & bit;
      m2 |= m1 & bit;
      m1 |= bit;
      switch (c & 3) {
        case 0: s0 |= bit; break;
        case 1: s1 |= bit; break;
        case 2: s2 |= bit; break;
        default: s3 |= bit;
      }
    }
    this.m1 = m1;
    this.m2 = m2;
    this.m3 = m3;
    this.m4 = m4;
    // At most one suit can have 3+ of the 5 board cards.
    if (POPCOUNT[s0] >= 3) { this.flushSuit = 0; this.flushBase = s0; }
    else if (POPCOUNT[s1] >= 3) { this.flushSuit = 1; this.flushBase = s1; }
    else if (POPCOUNT[s2] >= 3) { this.flushSuit = 2; this.flushBase = s2; }
    else if (POPCOUNT[s3] >= 3) { this.flushSuit = 3; this.flushBase = s3; }
    else { this.flushSuit = -1; this.flushBase = 0; }
  }

  /** Strength of board + hole cards a, b (both off the board). */
  evalHole(a, b) {
    let m1 = this.m1, m2 = this.m2, m3 = this.m3, m4 = this.m4;
    let bit = 1 << (a >> 2);
    m4 |= m3 & bit;
    m3 |= m2 & bit;
    m2 |= m1 & bit;
    m1 |= bit;
    bit = 1 << (b >> 2);
    m4 |= m3 & bit;
    m3 |= m2 & bit;
    m2 |= m1 & bit;
    m1 |= bit;
    let flush = 0;
    const fs = this.flushSuit;
    if (fs >= 0) {
      flush = this.flushBase;
      if ((a & 3) === fs) flush |= 1 << (a >> 2);
      if ((b & 3) === fs) flush |= 1 << (b >> 2);
      if (POPCOUNT[flush] < 5) flush = 0;
    }
    return strengthFromMasks(flush, m1, m2, m3, m4);
  }
}

/** Category index 0..8 from a strength value. */
export function categoryOf(strength) {
  return strength >> 20;
}

/** Hand category name from a strength value, e.g. 'Flush'. */
export function handCategory(strength) {
  const name = CATEGORY_NAMES[strength >> 20];
  if (name === undefined) throw new Error(`Invalid hand strength ${strength}`);
  return name;
}
