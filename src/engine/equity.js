// Equity calculations.
//
// A player is either a specific hand ('AsKd', 'As Kd', [51, 45]) or a range
// (notation string such as 'QQ+, AKs', or a range Map from ranges.js).
// Results: { players: [{ win, tie, equity }], method, ... } where win is the
// probability of winning outright, tie the probability of splitting the pot and
// equity = win + the expected share of split pots.
//
// Exact enumeration walks every runout once and, for each runout, evaluates every
// player's combos against it (board-centric). Matchups are then summed per runout:
// heads-up with a sort-and-sweep using per-card weight sums for card removal,
// multiway by walking the non-conflicting combo tuples. When the spot is fully
// suit-symmetric (no board, no dead cards, ranges made of whole classes) only the
// 134,459 suit-canonical boards are enumerated, each weighted by its orbit size.

import { parseCards, cardToString } from './cards.js';
import { parseRange, classIndex, handClasses } from './ranges.js';
import { comboIndex, comboWeights, COMBO_CARDS, CLASS_COMBOS } from './combos.js';
import { BoardEvaluator } from './evaluator.js';
import { createRng, randomSeed } from './rng.js';

// ---------------------------------------------------------------------------
// Spot preparation

function describePlayer(i) {
  return `Player ${i + 1}`;
}

/** Normalises one player input to { weights: Float64Array(1326), specific: bool }. */
function playerWeights(input, i) {
  const who = describePlayer(i);
  let cards = null;
  if (Array.isArray(input)) {
    try {
      cards = parseCards(input);
    } catch (err) {
      throw new Error(`${who}: ${err.message}`);
    }
    if (cards.length !== 2) throw new Error(`${who}: a hand needs exactly 2 cards`);
  } else if (typeof input === 'string') {
    try {
      cards = parseCards(input);
    } catch {
      cards = null;
    }
    if (cards && cards.length !== 2) cards = null; // e.g. 'AsKs AhKh' is a range of two combos
  } else if (!(input instanceof Map)) {
    throw new Error(`${who}: expected a hand like "AsKd" or a range`);
  }

  if (cards) {
    const weights = new Float64Array(1326);
    weights[comboIndex(cards[0], cards[1])] = 1;
    return { weights, specific: true };
  }
  try {
    return { weights: comboWeights(input instanceof Map ? input : parseRange(input)), specific: false };
  } catch (err) {
    throw new Error(`${who}: ${err.message}`);
  }
}

function comboString(i) {
  return cardToString(COMBO_CARDS[2 * i]) + cardToString(COMBO_CARDS[2 * i + 1]);
}

/** Validates inputs and builds per-player combo lists with card removal applied. */
function prepareSpot(players, board, dead) {
  if (!Array.isArray(players) || players.length < 2) throw new Error('Need at least two players');
  const boardCards = parseCards(board);
  const deadCards = parseCards(dead);
  if (boardCards.length > 5) throw new Error('The board has at most 5 cards');
  const blocked = new Uint8Array(52);
  for (const c of boardCards) blocked[c] = 1;
  for (const c of deadCards) {
    if (blocked[c]) throw new Error(`Dead card ${cardToString(c)} is also on the board`);
    blocked[c] = 1;
  }

  const ps = players.map((input, i) => {
    const p = playerWeights(input, i);
    for (let ci = 0; ci < 1326; ci++) {
      if (p.weights[ci] > 0 && (blocked[COMBO_CARDS[2 * ci]] || blocked[COMBO_CARDS[2 * ci + 1]])) {
        if (p.specific) {
          throw new Error(`${describePlayer(i)}: ${comboString(ci)} uses a card on the board or in dead cards`);
        }
        p.weights[ci] = 0;
      }
    }
    return p;
  });

  // Cards held in every combo of a player (both cards of a specific hand) can never
  // appear for anyone else or on the runout. Remove them, repeating until stable.
  const fixedOwner = new Int8Array(52).fill(-1);
  for (let changed = true; changed; ) {
    changed = false;
    ps.forEach((p, i) => {
      const count = new Float64Array(52);
      let n = 0;
      for (let ci = 0; ci < 1326; ci++) {
        if (p.weights[ci] > 0) {
          n++;
          count[COMBO_CARDS[2 * ci]]++;
          count[COMBO_CARDS[2 * ci + 1]]++;
        }
      }
      if (n === 0) throw new Error(`${describePlayer(i)} has no possible hands after card removal`);
      for (let c = 0; c < 52; c++) {
        if (count[c] !== n || fixedOwner[c] === i) continue;
        if (fixedOwner[c] >= 0) {
          throw new Error(`${describePlayer(fixedOwner[c])} and ${describePlayer(i)} both need ${cardToString(c)}`);
        }
        fixedOwner[c] = i;
        changed = true;
        ps.forEach((q, j) => {
          if (j === i) return;
          for (let ci = 0; ci < 1326; ci++) {
            if (q.weights[ci] > 0 && (COMBO_CARDS[2 * ci] === c || COMBO_CARDS[2 * ci + 1] === c)) {
              if (q.specific) {
                throw new Error(`${describePlayer(i)} and ${describePlayer(j)} both need ${cardToString(c)}`);
              }
              q.weights[ci] = 0;
            }
          }
        });
      }
    });
  }

  let symmetric = boardCards.length === 0 && deadCards.length === 0 && fixedOwner.every((o) => o < 0);
  const prepared = ps.map((p) => {
    const idx = [];
    for (let ci = 0; ci < 1326; ci++) if (p.weights[ci] > 0) idx.push(ci);
    const n = idx.length;
    const list = {
      n,
      idx: Uint16Array.from(idx),
      a: Uint8Array.from(idx, (ci) => COMBO_CARDS[2 * ci]),
      b: Uint8Array.from(idx, (ci) => COMBO_CARDS[2 * ci + 1]),
      w: Float64Array.from(idx, (ci) => p.weights[ci]),
    };
    if (symmetric && !isClassUniform(p.weights)) symmetric = false;
    return { weights: p.weights, specific: p.specific, list };
  });

  const deckCards = [];
  for (let c = 0; c < 52; c++) if (!blocked[c] && fixedOwner[c] < 0) deckCards.push(c);

  return {
    board: boardCards,
    dead: deadCards,
    players: prepared,
    deck: deckCards,
    need: 5 - boardCards.length,
    symmetric,
  };
}

/** True when every combo of each class has the same weight (range invariant under suit permutations). */
function isClassUniform(weights) {
  for (const combos of CLASS_COMBOS) {
    const w = weights[combos[0]];
    for (let k = 1; k < combos.length; k++) if (weights[combos[k]] !== w) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Suit-canonical 5-card boards

const CANONICAL_BOARD_COUNT = 134459;
let canonical = null;

/**
 * All 5-card boards up to suit permutation: { cards: Uint8Array(5n), mult: Uint8Array(n), count }.
 * A board's four per-suit rank masks, sorted, identify its orbit; mult is the orbit size.
 * count = 134,459 and the multiplicities sum to C(52,5) = 2,598,960.
 */
export function canonicalBoards() {
  if (canonical) return canonical;
  const byPop = [[], [], [], [], [], []];
  for (let m = 0; m < 8192; m++) {
    let pop = 0;
    for (let x = m; x; x &= x - 1) pop++;
    if (pop <= 5) byPop[pop].push(m); // ascending
  }
  const cards = [];
  const mult = [];
  const masks = [0, 0, 0, 0];
  const factorial = [1, 1, 2, 6, 24];
  const emit = () => {
    for (let s = 0; s < 4; s++) {
      for (let r = 0; r < 13; r++) if (masks[s] & (1 << r)) cards.push(r * 4 + s);
    }
    let stab = 1;
    for (let s = 0; s < 4; ) {
      let e = s;
      while (e < 4 && masks[e] === masks[s]) e++;
      stab *= factorial[e - s];
      s = e;
    }
    mult.push(24 / stab);
  };
  const rec = (level, maxMask, remaining) => {
    if (remaining === 0) {
      for (let s = level; s < 4; s++) masks[s] = 0;
      emit();
      return;
    }
    if (level === 4) return;
    // Masks are in descending numeric order across suits; a mask with fewer bits can
    // still be numerically larger, so every popcount up to `remaining` is tried.
    for (let pop = 1; pop <= remaining; pop++) {
      for (const m of byPop[pop]) {
        if (m > maxMask) break;
        masks[level] = m;
        rec(level + 1, m, remaining - pop);
      }
    }
  };
  rec(0, 8191, 5);
  canonical = { cards: Uint8Array.from(cards), mult: Uint8Array.from(mult), count: mult.length };
  return canonical;
}

// ---------------------------------------------------------------------------
// Exact enumeration

function makeScratch(spot) {
  return spot.players.map(({ list }) => ({
    n: 0,
    idx: new Uint16Array(list.n),
    a: new Uint8Array(list.n),
    b: new Uint8Array(list.n),
    w: new Float64Array(list.n),
    s: new Int32Array(list.n),
    keys: new Float64Array(list.n),
    order: new Uint16Array(list.n),
  }));
}

/**
 * In-place ascending sort of a[lo..hi] (quicksort + insertion sort). About 3x faster
 * than TypedArray.prototype.sort for the few hundred keys sorted per runout.
 */
export function sortNumbers(a, lo, hi) {
  while (hi - lo > 16) {
    const x = a[lo];
    const y = a[(lo + hi) >> 1];
    const z = a[hi];
    const p = x < y ? (y < z ? y : x < z ? z : x) : x < z ? x : y < z ? z : y;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j) {
        const t = a[i];
        a[i++] = a[j];
        a[j--] = t;
      }
    }
    if (j - lo < hi - i) {
      sortNumbers(a, lo, j);
      lo = i;
    } else {
      sortNumbers(a, i, hi);
      hi = j;
    }
  }
  for (let i = lo + 1; i <= hi; i++) {
    const v = a[i];
    let j = i - 1;
    while (j >= lo && a[j] > v) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = v;
  }
}

/** Sorts a runout list by strength (ascending) into L.order. */
function sortList(L) {
  const n = L.n;
  const keys = L.keys;
  for (let i = 0; i < n; i++) keys[i] = L.s[i] * 2048 + i;
  sortNumbers(keys, 0, n - 1);
  for (let i = 0; i < n; i++) L.order[i] = keys[i] % 2048;
}

/** Heads-up accumulation for one runout. acc = [win0, win1, tie, total]. */
function headsUp(L0, L1, w1ByCombo, mult, acc, cardSums) {
  const n0 = L0.n;
  const n1 = L1.n;
  if (n0 * n1 <= 64) {
    for (let i = 0; i < n0; i++) {
      const a = L0.a[i];
      const b = L0.b[i];
      const s = L0.s[i];
      const w0 = L0.w[i] * mult;
      for (let j = 0; j < n1; j++) {
        const c = L1.a[j];
        const d = L1.b[j];
        if (c === a || c === b || d === a || d === b) continue;
        const w = w0 * L1.w[j];
        acc[3] += w;
        const t = L1.s[j];
        if (s > t) acc[0] += w;
        else if (s < t) acc[1] += w;
        else acc[2] += w;
      }
    }
    return;
  }

  // Sort-and-sweep. For a player-0 combo {a, b}, the weight of compatible player-1
  // combos in a set S is S - S[a] - S[b] + S[{a,b}] (inclusion-exclusion over cards).
  sortList(L0);
  sortList(L1);
  const all = cardSums[0];
  const below = cardSums[1];
  const equal = cardSums[2];
  let allSum = 0;
  for (let j = 0; j < n1; j++) {
    const w = L1.w[j];
    allSum += w;
    all[L1.a[j]] += w;
    all[L1.b[j]] += w;
  }
  let belowSum = 0;
  let j = 0;
  let i = 0;
  const o0 = L0.order;
  const o1 = L1.order;
  while (i < n0) {
    const s = L0.s[o0[i]];
    while (j < n1 && L1.s[o1[j]] < s) {
      const q = o1[j++];
      const w = L1.w[q];
      belowSum += w;
      below[L1.a[q]] += w;
      below[L1.b[q]] += w;
    }
    let equalSum = 0;
    let e = j;
    while (e < n1 && L1.s[o1[e]] === s) {
      const q = o1[e++];
      const w = L1.w[q];
      equalSum += w;
      equal[L1.a[q]] += w;
      equal[L1.b[q]] += w;
    }
    while (i < n0 && L0.s[o0[i]] === s) {
      const p = o0[i++];
      const a = L0.a[p];
      const b = L0.b[p];
      const w0 = L0.w[p] * mult;
      const same = w1ByCombo[L0.idx[p]]; // player 1 holding the very same combo
      const compat = allSum - all[a] - all[b] + same;
      const lose = belowSum - below[a] - below[b];
      const tie = equalSum - equal[a] - equal[b] + same;
      acc[0] += w0 * lose;
      acc[2] += w0 * tie;
      acc[1] += w0 * (compat - lose - tie);
      acc[3] += w0 * compat;
    }
    for (let t = j; t < e; t++) {
      const q = o1[t];
      equal[L1.a[q]] = 0;
      equal[L1.b[q]] = 0;
    }
  }
  for (let t = 0; t < n1; t++) {
    all[L1.a[t]] = 0;
    all[L1.b[t]] = 0;
    below[L1.a[t]] = 0;
    below[L1.b[t]] = 0;
  }
}

/** Multiway accumulation for one runout over all non-conflicting combo tuples. */
function multiway(lists, mult, acc, used, strengths) {
  const k = lists.length;
  const { win, tie, share } = acc;
  const rec = (p, w) => {
    if (p === k) {
      let best = -1;
      let count = 0;
      for (let q = 0; q < k; q++) {
        if (strengths[q] > best) {
          best = strengths[q];
          count = 1;
        } else if (strengths[q] === best) count++;
      }
      acc.total += w;
      for (let q = 0; q < k; q++) {
        if (strengths[q] !== best) continue;
        if (count === 1) win[q] += w;
        else {
          tie[q] += w;
          share[q] += w / count;
        }
      }
      return;
    }
    const L = lists[p];
    for (let i = 0; i < L.n; i++) {
      const a = L.a[i];
      const b = L.b[i];
      if (used[a] || used[b]) continue;
      used[a] = 1;
      used[b] = 1;
      strengths[p] = L.s[i];
      rec(p + 1, w * L.w[i]);
      used[a] = 0;
      used[b] = 0;
    }
  };
  rec(0, mult);
}

function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/**
 * Exact equity of hands/ranges on a given board by enumerating every runout and
 * every non-conflicting combo matchup (weighted by the product of combo weights).
 * Returns { method: 'exact', players: [{ win, tie, equity }], runouts }.
 */
export function exactEquity(players, board = [], dead = [], { symmetry = true } = {}) {
  const spot = prepareSpot(players, board, dead);
  const k = spot.players.length;
  const lists = makeScratch(spot);
  const ev = new BoardEvaluator();
  const full = new Uint8Array(5);
  full.set(spot.board);
  const nb = spot.board.length;
  const onRunout = new Uint8Array(52);
  const cardSums = [new Float64Array(52), new Float64Array(52), new Float64Array(52)];
  const hu = new Float64Array(4); // win0, win1, tie, total
  const acc = { win: new Float64Array(k), tie: new Float64Array(k), share: new Float64Array(k), total: 0 };
  const used = new Uint8Array(52);
  const strengths = new Int32Array(k);
  const w1ByCombo = k === 2 ? spot.players[1].weights : null;

  const processRunout = (mult) => {
    ev.setBoard(full);
    for (let t = nb; t < 5; t++) onRunout[full[t]] = 1;
    for (let p = 0; p < k; p++) {
      const src = spot.players[p].list;
      const L = lists[p];
      let n = 0;
      for (let i = 0; i < src.n; i++) {
        const a = src.a[i];
        const b = src.b[i];
        if (onRunout[a] || onRunout[b]) continue;
        L.idx[n] = src.idx[i];
        L.a[n] = a;
        L.b[n] = b;
        L.w[n] = src.w[i];
        L.s[n] = ev.evalHole(a, b);
        n++;
      }
      L.n = n;
    }
    for (let t = nb; t < 5; t++) onRunout[full[t]] = 0;
    if (k === 2) headsUp(lists[0], lists[1], w1ByCombo, mult, hu, cardSums);
    else multiway(lists, mult, acc, used, strengths);
  };

  let runouts = 0;
  if (spot.symmetric && symmetry) {
    const { cards, mult, count } = canonicalBoards();
    for (let i = 0; i < count; i++) {
      for (let t = 0; t < 5; t++) full[t] = cards[5 * i + t];
      processRunout(mult[i]);
      runouts += mult[i];
    }
  } else {
    const { deck: d, need } = spot;
    const n = d.length;
    if (need > n) throw new Error('Not enough cards left to complete the board');
    const ix = new Int32Array(need);
    for (let t = 0; t < need; t++) ix[t] = t;
    for (;;) {
      for (let t = 0; t < need; t++) full[nb + t] = d[ix[t]];
      processRunout(1);
      runouts++;
      let t = need - 1;
      while (t >= 0 && ix[t] === n - need + t) t--;
      if (t < 0) break;
      ix[t]++;
      for (let u = t + 1; u < need; u++) ix[u] = ix[u - 1] + 1;
    }
  }

  if (k === 2) {
    acc.win[0] = hu[0];
    acc.win[1] = hu[1];
    acc.tie[0] = acc.tie[1] = hu[2];
    acc.share[0] = acc.share[1] = hu[2] / 2;
    acc.total = hu[3];
  }
  if (!(acc.total > 0)) throw new Error('No valid matchups: the hands and ranges block each other completely');
  return {
    method: 'exact',
    players: Array.from({ length: k }, (_, p) => ({
      win: acc.win[p] / acc.total,
      tie: acc.tie[p] / acc.total,
      equity: (acc.win[p] + acc.share[p]) / acc.total,
    })),
    runouts,
  };
}

// ---------------------------------------------------------------------------
// Monte Carlo

/**
 * Monte Carlo equity for multiway or preflop range vs range. Each trial deals every
 * player a combo (rejection sampling, so the joint distribution matches exact
 * enumeration) and a random runout. Seedable for reproducible results.
 * Returns { method: 'montecarlo', players: [{ win, tie, equity, stdErr }], iterations, seed }.
 */
export function monteCarloEquity(players, board = [], { iterations = 100000, seed, dead = [] } = {}) {
  const spot = prepareSpot(players, board, dead);
  const k = spot.players.length;
  const useSeed = seed ?? randomSeed();
  const rng = createRng(useSeed);
  const cum = spot.players.map(({ list }) => {
    const c = new Float64Array(list.n);
    let t = 0;
    for (let i = 0; i < list.n; i++) c[i] = t += list.w[i];
    return c;
  });
  const deckCards = spot.deck;
  const nd = deckCards.length;
  const nb = spot.board.length;
  const need = spot.need;
  if (need > nd) throw new Error('Not enough cards left to complete the board');
  const full = new Uint8Array(5);
  full.set(spot.board);
  const ev = new BoardEvaluator();
  const used = new Uint8Array(52);
  const holeA = new Uint8Array(k);
  const holeB = new Uint8Array(k);
  const strengths = new Int32Array(k);
  const wins = new Float64Array(k);
  const ties = new Float64Array(k);
  const sum = new Float64Array(k);
  const sumSq = new Float64Array(k);

  const pick = (c) => {
    const u = rng.float() * c[c.length - 1];
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid] > u) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  for (let it = 0; it < iterations; it++) {
    for (let attempts = 0; ; attempts++) {
      if (attempts > 10000) throw new Error('Could not deal non-conflicting hands: the ranges block each other');
      let dealt = 0;
      for (; dealt < k; dealt++) {
        const L = spot.players[dealt].list;
        const i = pick(cum[dealt]);
        const a = L.a[i];
        const b = L.b[i];
        if (used[a] || used[b]) break;
        used[a] = 1;
        used[b] = 1;
        holeA[dealt] = a;
        holeB[dealt] = b;
      }
      if (dealt === k) break;
      for (let p = 0; p < dealt; p++) {
        used[holeA[p]] = 0;
        used[holeB[p]] = 0;
      }
    }
    for (let t = nb; t < 5; t++) {
      let c;
      do c = deckCards[rng.int(nd)];
      while (used[c]);
      used[c] = 1;
      full[t] = c;
    }
    ev.setBoard(full);
    let best = -1;
    let count = 0;
    for (let p = 0; p < k; p++) {
      const s = ev.evalHole(holeA[p], holeB[p]);
      strengths[p] = s;
      if (s > best) {
        best = s;
        count = 1;
      } else if (s === best) count++;
    }
    for (let p = 0; p < k; p++) {
      if (strengths[p] === best) {
        const x = 1 / count;
        sum[p] += x;
        sumSq[p] += x * x;
        if (count === 1) wins[p]++;
        else ties[p]++;
      }
      used[holeA[p]] = 0;
      used[holeB[p]] = 0;
    }
    for (let t = nb; t < 5; t++) used[full[t]] = 0;
  }

  const n = iterations;
  return {
    method: 'montecarlo',
    players: Array.from({ length: k }, (_, p) => {
      const mean = sum[p] / n;
      const variance = n > 1 ? Math.max(0, (sumSq[p] - n * mean * mean) / (n - 1)) : 0;
      return { win: wins[p] / n, tie: ties[p] / n, equity: mean, stdErr: Math.sqrt(variance / n) };
    }),
    iterations: n,
    seed: useSeed,
  };
}

// ---------------------------------------------------------------------------
// Choosing a method

/**
 * Rough run time of exact enumeration in nanoseconds (fitted on V8, desktop CPU).
 * Per runout: fixed overhead, evaluating each live combo, then the matchup work
 * (pairwise or sort-and-sweep heads-up, combo tuples multiway).
 */
export function exactCost(players, board = [], dead = []) {
  return spotCost(prepareSpot(players, board, dead));
}

function spotCost(spot) {
  const runouts = spot.symmetric ? CANONICAL_BOARD_COUNT : binomial(spot.deck.length, spot.need);
  const sizes = spot.players.map((p) => p.list.n);
  const combos = sizes.reduce((x, y) => x + y, 0);
  let matchups;
  if (sizes.length === 2) {
    const [n0, n1] = sizes;
    matchups = n0 * n1 <= 64 ? 10 * n0 * n1 : 20 * combos + 1.5 * (n0 * Math.log2(n0 + 1) + n1 * Math.log2(n1 + 1));
  } else {
    matchups = 20 * sizes.length + 15 * sizes.reduce((x, y) => x * y, 1);
  }
  return runouts * (60 + 10 * combos + matchups);
}

/** Estimated-time budget (ns) under which 'auto' picks exact enumeration. */
export const EXACT_BUDGET = 1.5e9;

/** 'exact' when enumeration is cheap enough, otherwise 'montecarlo'. */
export function chooseMethod(players, board = [], dead = [], budget = EXACT_BUDGET) {
  return exactCost(players, board, dead) <= budget ? 'exact' : 'montecarlo';
}

// ---------------------------------------------------------------------------
// Precomputed preflop table

const TABLE_URL = new URL('../../data/preflop-equity-169.json', import.meta.url);
let preflopTable = null;

/** Installs a table object { classes: string[169], equity: number[169][169] }. */
export function setPreflopTable(table) {
  if (!table || !Array.isArray(table.equity) || table.equity.length !== 169) {
    throw new Error('Invalid preflop equity table');
  }
  const order = handClasses();
  if (table.classes && table.classes.some((c, i) => c !== order[i])) {
    throw new Error('Preflop equity table uses a different class order');
  }
  preflopTable = table;
}

function loadTableSync(url = TABLE_URL) {
  // Node only (process.getBuiltinModule exists from Node 20.16 / 22.3); browsers use loadPreflopTable().
  const fs = globalThis.process?.getBuiltinModule?.('node:fs');
  if (!fs || url.protocol !== 'file:' || !fs.existsSync(url)) return;
  setPreflopTable(JSON.parse(fs.readFileSync(url, 'utf8')));
}

/** Loads data/preflop-equity-169.json (fetch in browsers, fs in Node). Resolves true if available. */
export async function loadPreflopTable(url = TABLE_URL) {
  if (preflopTable) return true;
  try {
    if (String(url).startsWith('file:')) loadTableSync(new URL(url));
    else {
      const res = await fetch(url);
      if (res.ok) setPreflopTable(await res.json());
    }
  } catch {
    return false;
  }
  return preflopTable !== null;
}

/**
 * Fast preflop lookup using the precomputed 169x169 table: equity of classA vs
 * classB, averaged over all non-conflicting combo matchups. Returns null when the
 * table has not been generated (npm run build:equity) or loaded yet.
 */
export function preflopEquity(classA, classB) {
  const a = classIndex(classA);
  const b = classIndex(classB);
  if (a < 0) throw new Error(`Unknown hand class "${classA}"`);
  if (b < 0) throw new Error(`Unknown hand class "${classB}"`);
  if (!preflopTable) loadTableSync();
  if (!preflopTable) return null;
  return preflopTable.equity[a][b];
}
