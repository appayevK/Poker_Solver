// Push/fold Nash equilibria.
//
// Model
// - Push/fold only: a player either folds or goes all-in; facing an all-in, a player
//   calls or folds. No limps and no raises short of all-in.
// - Stacks are in big blinds. Blinds default to 0.5 / 1; antes are per player, or one
//   big-blind ante posted by the BB. Antes are dead money; blinds are live.
// - Seats are in action order: first to act ... SB, BB (heads-up: SB, BB).
// - Strategies are per hand class (169, grid order): a jam / call frequency 0..1.
// - Card removal: hero's class a meets villain's class b with weight PAIRS[a][b]
//   (compatible combo pairs, see card-removal.js), never b's raw combo count. The
//   chance that each player behind calls is computed against the jammer's hand.
//   Card removal from players who folded is ignored (their cards stay in the deck and
//   do not change anyone else's range) - the standard simplification.
// - maxCallers = 1: once someone calls, everyone behind folds, so every all-in is
//   heads-up. Decision nodes: "open-jam when folded to" for every seat but the BB,
//   and "call vs a jam from seat X" for every seat behind X.
// - Equities come from the exact 169x169 preflop table. A split pot counts as half a
//   win and half a loss, which is exact in chip EV and a close approximation in ICM.
//
// Terminal values: every hand ends in one of a few outcomes - folded round to the BB,
// a steal by the jammer, or jammer vs one caller where the jammer wins or loses. The
// value of each outcome to each player is computed once:
//   chipEV  chips at the end minus chips at the start (bb);
//   icm     icmEquity of the final stack vector ($); a busted player gets the payout
//           for the place they finish in;
//   pko     icm $ plus bountyDollarValue for a player who busts someone they cover.
//           Without payouts, PKO is chip EV plus bountyChipValue (bb).
// A class's EV for an action is then a weighted sum of these values with equities and
// card-removal weights, so each solver iteration costs O(nodes x 169 x 169).

import { handClasses, classIndex, comboClass } from '../engine/ranges.js';
import { parseCards } from '../engine/cards.js';
import { PAIRS as PAIRS_MATRIX, CLASS_COMBO_COUNTS, TOTAL_PAIRS as ALL_PAIRS, equityMatrix } from './card-removal.js';
import { solve } from './fictitious-play.js';
import { icmEquity, checkPayouts } from '../calc/icm.js';
import { bountyDollarValue, bountyChipValue } from '../calc/pko.js';

const CLASSES = handClasses();
const N = 169;
const POSITIONS = ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
export const MAX_SEATS = 9;

/** Position labels for n seats in action order: 2 → SB, BB; 3 → BTN, SB, BB; ... */
export function positionLabels(n) {
  return POSITIONS.slice(POSITIONS.length - n);
}

function checkNumber(name, value, min = 0, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number (got ${value})`);
  if (value < min || value > max) {
    throw new Error(
      max === Infinity ? `${name} must be at least ${min} (got ${value})` : `${name} must be between ${min} and ${max} (got ${value})`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Parameters and terminal values

/** Validates and fills in defaults for a table spot. */
export function normalizeSpot({
  stacks,
  blinds = {},
  mode = 'chipEV',
  payouts,
  bounties,
  headValueFactor = 0,
  maxCallers = 1,
  otherStacks = [],
  bountyRate,
  startingBounty,
  startingStack,
} = {}) {
  if (!Array.isArray(stacks) || stacks.length < 2 || stacks.length > MAX_SEATS) {
    throw new Error(`Push/fold needs 2 to ${MAX_SEATS} stacks`);
  }
  stacks.forEach((s, i) => {
    checkNumber(`Stack of seat ${i + 1}`, s);
    if (s <= 0) throw new Error(`Stack of seat ${i + 1} must be greater than 0`);
  });
  const { sb = 0.5, bb = 1, ante = 0, bbAnte = false } = blinds;
  checkNumber('Small blind', sb);
  checkNumber('Big blind', bb);
  checkNumber('Ante', ante);
  if (!['chipEV', 'icm', 'pko'].includes(mode)) throw new Error(`Mode must be chipEV, icm or pko (got ${mode})`);
  if (maxCallers !== 1) throw new Error('Only maxCallers = 1 (heads-up all-ins) is supported');
  if (!Array.isArray(otherStacks)) throw new Error('otherStacks must be an array');
  otherStacks.forEach((s, i) => checkNumber(`Other stack ${i + 1}`, s));
  const useIcm = mode === 'icm' || (mode === 'pko' && Array.isArray(payouts));
  if (useIcm) {
    checkPayouts(payouts);
    if (stacks.length + otherStacks.length > 12) throw new Error('ICM handles up to 12 players in total');
  }
  let rate = null;
  if (mode === 'pko') {
    if (!Array.isArray(bounties) || bounties.length !== stacks.length) throw new Error('PKO needs one bounty per seat');
    bounties.forEach((b, i) => checkNumber(`Bounty of seat ${i + 1}`, b));
    checkNumber('Head-value factor', headValueFactor, 0, 1);
    if (!useIcm) {
      if (bountyRate !== undefined && bountyRate !== null) rate = checkNumber('Bounty rate ($ per bb)', bountyRate);
      else {
        checkNumber('Starting bounty', startingBounty);
        checkNumber('Starting stack', startingStack);
        if (startingStack <= 0) throw new Error('Starting stack must be greater than 0');
        rate = startingBounty / startingStack;
      }
      if (!(rate > 0)) throw new Error('Bounty rate must be greater than 0');
    }
  }
  return {
    stacks: stacks.slice(),
    blinds: { sb, bb, ante, bbAnte: !!bbAnte },
    mode,
    useIcm,
    payouts: useIcm ? payouts.slice() : null,
    bounties: mode === 'pko' ? bounties.slice() : null,
    headValueFactor,
    rate,
    otherStacks: otherStacks.slice(),
    unit: useIcm ? '$' : 'bb',
  };
}

/**
 * Final stack vectors and their value to every player for each outcome:
 * walk (folded to the BB), steal[i], win[i][k] / lose[i][k] (jammer i vs caller k,
 * jammer wins / loses). Values are Float64Array(n), one entry per seat.
 */
export function terminalValues(spot) {
  const { stacks: S, blinds, useIcm, payouts, bounties, headValueFactor, rate, otherStacks } = spot;
  const n = S.length;
  const sbSeat = n === 2 ? 0 : n - 2;
  const bbSeat = n - 1;
  const dead = new Array(n).fill(0);
  const live = new Array(n).fill(0);
  if (blinds.ante > 0) {
    if (blinds.bbAnte) dead[bbSeat] = Math.min(blinds.ante, S[bbSeat]);
    else for (let i = 0; i < n; i++) dead[i] = Math.min(blinds.ante, S[i]);
  }
  live[sbSeat] = Math.min(blinds.sb, S[sbSeat] - dead[sbSeat]);
  live[bbSeat] = Math.min(blinds.bb, S[bbSeat] - dead[bbSeat]);
  const posted = S.map((_, i) => dead[i] + live[i]);
  const totalPosted = posted.reduce((a, b) => a + b, 0);
  const afterPosting = () => S.map((s, i) => s - posted[i]);

  const bountyValue = (bounty) =>
    useIcm ? bountyDollarValue({ bounty, headValueFactor }) : bountyChipValue({ bounty, headValueFactor, rate });

  const score = (final, buster = -1, busted = -1) => {
    let v;
    if (useIcm) {
      const all = final.concat(otherStacks);
      const ev = icmEquity(all, payouts);
      v = Float64Array.from(final, (_, i) => ev[i]);
      if (busted >= 0) {
        const left = all.filter((x) => x > 0).length;
        v[busted] = payouts[left] ?? 0;
      }
    } else {
      v = Float64Array.from(final, (x, i) => x - S[i]);
    }
    if (bounties && buster >= 0) v[buster] += bountyValue(bounties[busted]);
    return v;
  };

  const walkFinal = afterPosting();
  walkFinal[bbSeat] += totalPosted;
  const walk = score(walkFinal);

  const steal = [];
  const win = [];
  const lose = [];
  for (let i = 0; i < n - 1; i++) {
    const f = afterPosting();
    f[i] += totalPosted;
    steal[i] = score(f);
    win[i] = [];
    lose[i] = [];
    for (let k = i + 1; k < n; k++) {
      const matched = Math.min(S[i] - dead[i], S[k] - dead[k]);
      const pot = totalPosted - live[i] - live[k] + 2 * matched;
      const base = afterPosting();
      base[i] = S[i] - dead[i] - matched;
      base[k] = S[k] - dead[k] - matched;
      const w = base.slice();
      w[i] += pot;
      const l = base.slice();
      l[k] += pot;
      win[i][k] = score(w, w[k] === 0 ? i : -1, w[k] === 0 ? k : -1);
      lose[i][k] = score(l, l[i] === 0 ? k : -1, l[i] === 0 ? i : -1);
    }
  }
  return { walk, steal, win, lose, posted, sbSeat, bbSeat };
}

// ---------------------------------------------------------------------------
// The game

/** Builds the push/fold game for fictitious play. */
export function buildGame(spot) {
  const n = spot.stacks.length;
  const V = terminalValues(spot);
  // Local bindings: the hot loops below must not go through module imports (test
  // runners rewrite those into property lookups, which is many times slower).
  const PAIRS = PAIRS_MATRIX;
  const TOTAL_PAIRS = ALL_PAIRS;
  const E = equityMatrix();
  const PE = new Float64Array(N * N);
  for (let x = 0; x < N * N; x++) PE[x] = PAIRS[x] * E[x];
  const invPairsOf = Float64Array.from(CLASS_COMBO_COUNTS, (c) => 1 / (c * 1225));
  const prior = Float64Array.from(CLASS_COMBO_COUNTS, (c) => c / 1326);

  const nodes = [];
  const openIdx = [];
  const callIdx = [];
  for (let i = 0; i < n - 1; i++) {
    openIdx[i] = nodes.length;
    nodes.push({ id: `open:${i}`, type: 'open', player: i, seat: i });
  }
  for (let i = 0; i < n - 1; i++) {
    callIdx[i] = [];
    for (let j = i + 1; j < n; j++) {
      callIdx[i][j] = nodes.length;
      nodes.push({ id: `call:${i}:${j}`, type: 'call', player: j, seat: j, jammer: i });
    }
  }

  // Scratch buffers, reused every evaluation.
  const C = Array.from({ length: n }, () => new Float64Array(N)); // P(seat m calls | jammer class a)
  const W = Array.from({ length: n }, () => new Float64Array(N)); // P(m calls and jammer wins | a)
  const F = Array.from({ length: n }, () => new Float64Array(N)); // P(seats before m fold | a)
  let R = new Float64Array(N * n); // R[a * n + p]: value to p given the jam, a, and it is m's turn
  let Rnext = new Float64Array(N * n);
  const acc1 = new Float64Array(N);
  const acc2 = new Float64Array(N);
  const Z = new Float64Array(N);
  const gaps = nodes.map(() => new Float64Array(N));
  const weights = nodes.map(() => new Float64Array(N));
  const actionEV = nodes.map(() => new Float64Array(N));
  const foldEV = nodes.map(() => new Float64Array(N));
  const openEV = Array.from({ length: n }, () => new Float64Array(N)); // R(i, i+1 | a)[i]
  const jamPart = Array.from({ length: n }, () => new Float64Array(n)); // sum_a prior * s * R(i,i+1|a)
  const jamProb = new Float64Array(n);
  const foldTo = new Float64Array(n);
  const CV = Array.from({ length: n }, () => new Float64Array(n)); // value of "folded to seat i"

  function evaluate(strategies) {
    for (let i = 0; i < n - 1; i++) {
      const s = strategies[openIdx[i]];
      let p = 0;
      for (let a = 0; a < N; a++) p += prior[a] * s[a];
      jamProb[i] = p;
    }
    foldTo[0] = 1;
    for (let i = 1; i < n; i++) foldTo[i] = foldTo[i - 1] * (1 - jamProb[i - 1]);

    for (let i = 0; i < n - 1; i++) {
      const s = strategies[openIdx[i]];
      // Call probabilities of every seat behind, given the jammer's class.
      for (let m = i + 1; m < n; m++) {
        const c = strategies[callIdx[i][m]];
        const Cm = C[m];
        const Wm = W[m];
        for (let a = 0; a < N; a++) {
          let sc = 0;
          let sw = 0;
          const row = a * N;
          for (let b = 0; b < N; b++) {
            const cb = c[b];
            if (cb === 0) continue;
            sc += PAIRS[row + b] * cb;
            sw += PE[row + b] * cb;
          }
          Cm[a] = sc * invPairsOf[a];
          Wm[a] = sw * invPairsOf[a];
        }
      }
      F[i + 1].fill(1);
      for (let m = i + 1; m < n - 1; m++) {
        for (let a = 0; a < N; a++) F[m + 1][a] = F[m][a] * (1 - C[m][a]);
      }

      // Backward over the seats behind: R(i, m | a) from R(i, m + 1 | a).
      const stealV = V.steal[i];
      for (let a = 0; a < N; a++) for (let p = 0; p < n; p++) Rnext[a * n + p] = stealV[p];
      for (let m = n - 1; m > i; m--) {
        const node = callIdx[i][m];
        const vw = V.win[i][m][m]; // caller's value when the jammer wins
        const vl = V.lose[i][m][m];
        acc1.fill(0);
        acc2.fill(0);
        Z.fill(0);
        for (let a = 0; a < N; a++) {
          const g = s[a] * F[m][a];
          if (g === 0) continue;
          const h = g * (vl - Rnext[a * n + m]);
          const row = a * N;
          for (let b = 0; b < N; b++) {
            const pab = PAIRS[row + b];
            acc1[b] += g * PE[row + b];
            acc2[b] += h * pab;
            Z[b] += g * pab;
          }
        }
        const gap = gaps[node];
        const weight = weights[node];
        const aEV = actionEV[node];
        const fEV = foldEV[node];
        for (let b = 0; b < N; b++) {
          if (Z[b] > 1e-12) {
            gap[b] = ((vw - vl) * acc1[b] + acc2[b]) / Z[b];
            fEV[b] = vl - acc2[b] / Z[b];
          } else {
            gap[b] = 0;
            fEV[b] = vl;
          }
          aEV[b] = fEV[b] + gap[b];
          weight[b] = (foldTo[i] * Z[b]) / TOTAL_PAIRS;
        }

        const winV = V.win[i][m];
        const loseV = V.lose[i][m];
        const Cm = C[m];
        const Wm = W[m];
        for (let a = 0; a < N; a++) {
          const c = Cm[a];
          const w = Wm[a];
          const keep = 1 - c;
          const off = a * n;
          for (let p = 0; p < n; p++) R[off + p] = w * winV[p] + (c - w) * loseV[p] + keep * Rnext[off + p];
        }
        [R, Rnext] = [Rnext, R];
      }
      // Rnext now holds R(i, i + 1 | a).
      const jp = jamPart[i];
      jp.fill(0);
      for (let a = 0; a < N; a++) {
        openEV[i][a] = Rnext[a * n + i];
        const wgt = prior[a] * s[a];
        if (wgt === 0) continue;
        for (let p = 0; p < n; p++) jp[p] += wgt * Rnext[a * n + p];
      }
    }

    // Value of the hand once it is folded to seat i.
    CV[n - 1].set(V.walk);
    for (let i = n - 2; i >= 0; i--) {
      for (let p = 0; p < n; p++) CV[i][p] = jamPart[i][p] + (1 - jamProb[i]) * CV[i + 1][p];
    }
    for (let i = 0; i < n - 1; i++) {
      const node = openIdx[i];
      const foldValue = CV[i + 1][i];
      for (let a = 0; a < N; a++) {
        gaps[node][a] = openEV[i][a] - foldValue;
        actionEV[node][a] = openEV[i][a];
        foldEV[node][a] = foldValue;
        weights[node][a] = foldTo[i] * prior[a];
      }
    }
    return { gaps, weights, actionEV, foldEV, values: CV[0] };
  }

  return { players: n, nodes, evaluate, openIdx, callIdx, terminal: V };
}

// ---------------------------------------------------------------------------
// Solving

/** Snaps a frequency for display: below 1% → 0, above 99% → 1, otherwise 2 decimals. */
function snap(x) {
  if (x < 0.01) return 0;
  if (x > 0.99) return 1;
  return Math.round(x * 100) / 100;
}

/**
 * Range Map (class → frequency) from a 169-vector of frequencies. With evGap, a class
 * whose EV gap is above epsilon plays the action (1) and one below -epsilon folds (0):
 * at equilibrium only indifferent hands mix, so this removes the small lag of averaged
 * fictitious play. Classes within epsilon keep their solved frequency.
 */
export function strategyToRange(strategy, evGap, epsilon = 0) {
  const range = new Map();
  for (let c = 0; c < N; c++) {
    let w = strategy[c];
    if (evGap) {
      if (evGap[c] > epsilon) w = 1;
      else if (evGap[c] < -epsilon) w = 0;
    }
    w = snap(w);
    if (w > 0) range.set(CLASSES[c], w);
  }
  return range;
}

/** EV gap below which a hand counts as indifferent when ranges are displayed. */
function displayEpsilon(spot) {
  return spot.useIcm ? 1e-5 * spot.payouts.reduce((a, b) => a + b, 0) : 1e-3;
}

/** Default stopping point: 2e-4 bb in chip EV, or the same share of the prize pool in ICM. */
function defaultTolerance(spot) {
  if (spot.useIcm) return 2e-6 * spot.payouts.reduce((a, b) => a + b, 0);
  return 2e-4;
}

/**
 * Multi-player push/fold (2-9 handed, maxCallers = 1).
 * params: { stacks (bb, action order), blinds: { sb, bb, ante, bbAnte }, mode:
 *   'chipEV' | 'icm' | 'pko', payouts ($ per place), bounties ($ per seat),
 *   headValueFactor, bountyRate or startingBounty + startingStack (chip-EV PKO),
 *   otherStacks (ICM: players not in the hand), maxCallers = 1,
 *   iterations, tolerance, averaging, step, onProgress }
 * Returns { seats: [{ seat, position, stack, openJam: Map | null, callVs: { [jammer]: Map } }],
 *   nodes: [{ id, type, seat, jammer, strategy, evGap, actionEV, foldEV }], exploitability
 *   (per seat), iterations, converged, unit, values (EV of the hand per seat),
 *   displayEpsilon, elapsedMs }. The Maps purify near-pure classes (see strategyToRange);
 *   nodes keep the raw solved frequencies.
 */
export function tablePushFold(params = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const spot = normalizeSpot(params);
  const game = buildGame(spot);
  const n = spot.stacks.length;
  const result = solve(game, {
    iterations: params.iterations ?? 3000,
    tolerance: params.tolerance ?? defaultTolerance(spot),
    averaging: params.averaging ?? 'linear',
    step: params.step,
    onProgress: params.onProgress,
    progressEvery: params.progressEvery ?? 25,
  });
  const details = game.evaluate(result.strategies);
  const positions = positionLabels(n);
  const nodes = game.nodes.map((node, k) => ({
    id: node.id,
    type: node.type,
    seat: node.seat,
    jammer: node.jammer,
    strategy: Array.from(result.strategies[k]),
    evGap: Array.from(details.gaps[k]),
    actionEV: Array.from(details.actionEV[k]),
    foldEV: Array.from(details.foldEV[k]),
  }));
  const epsilon = displayEpsilon(spot);
  const rangeAt = (k) => strategyToRange(result.strategies[k], details.gaps[k], epsilon);
  const seats = spot.stacks.map((stack, seat) => {
    const callVs = {};
    for (let i = 0; i < seat; i++) callVs[i] = rangeAt(game.callIdx[i][seat]);
    return {
      seat,
      position: positions[seat],
      stack,
      openJam: seat < n - 1 ? rangeAt(game.openIdx[seat]) : null,
      callVs,
    };
  });
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    mode: spot.mode,
    unit: spot.unit,
    positions,
    stacks: spot.stacks,
    seats,
    nodes,
    exploitability: result.exploitability,
    iterations: result.iterations,
    converged: result.converged,
    values: Array.from(details.values),
    displayEpsilon: epsilon,
    elapsedMs: t1 - t0,
  };
}

/**
 * Multi-player push/fold (3-9 handed).
 * mode: 'chipEV' | 'icm' | 'pko'. Thin wrapper around tablePushFold; `ante` may be
 * given at the top level as in the original stub.
 */
export function multiwayPushFold({ stacks, blinds = {}, ante, payouts, bounties, mode = 'chipEV', ...rest }) {
  return tablePushFold({
    ...rest,
    stacks,
    blinds: ante === undefined ? blinds : { ...blinds, ante },
    payouts,
    bounties,
    mode,
  });
}

/**
 * Heads-up SB jam / BB call ranges at an effective stack of stackBB.
 * icm: { payouts, otherStacks } (players not in the hand; with none, ICM is linear
 * heads-up and matches chip EV). pko: { bounties: [sb, bb], headValueFactor, bountyRate
 * or startingBounty + startingStack } and adds bounties to ICM (with icm) or chip EV.
 * Returns { sbJam, bbCall, exploitability, iterations, evs, ...table solution } where
 * evs = { sbJam[169], sbFold, bbCall[169], bbFold[169] } in bb (or $).
 */
export function headsUpPushFold({ stackBB, ante = 0, bbAnte = false, mode = 'chipEV', icm, pko, ...options } = {}) {
  checkNumber('Stack', stackBB);
  const solution = tablePushFold({
    ...options,
    stacks: [stackBB, stackBB],
    blinds: { sb: 0.5, bb: 1, ante, bbAnte },
    mode,
    payouts: icm?.payouts,
    otherStacks: icm?.otherStacks ?? [],
    bounties: pko?.bounties,
    headValueFactor: pko?.headValueFactor ?? 0,
    bountyRate: pko?.bountyRate,
    startingBounty: pko?.startingBounty,
    startingStack: pko?.startingStack,
  });
  const open = solution.nodes.find((x) => x.id === 'open:0');
  const call = solution.nodes.find((x) => x.id === 'call:0:1');
  return {
    ...solution,
    sbJam: solution.seats[0].openJam,
    bbCall: solution.seats[1].callVs[0],
    exploitability: Math.max(...solution.exploitability),
    exploitabilityPerSeat: solution.exploitability,
    evs: { sbJam: open.actionEV, sbFold: open.foldEV[0], bbCall: call.actionEV, bbFold: call.foldEV },
  };
}

/** Class index from a class name ('A9o') or exact cards ('AsKd'). */
function toClassIndex(hand) {
  let ci = classIndex(String(hand).trim());
  if (ci >= 0) return ci;
  const cards = parseCards(hand);
  if (cards.length !== 2) throw new Error(`"${hand}" is not a hand class or two cards`);
  ci = classIndex(comboClass(cards[0], cards[1]));
  return ci;
}

/**
 * Nash action for a hand at a node: { action: 'jam' | 'call' | 'fold', frequency, evGap, unit }.
 * node: 'open', or the jammer's seat as a number / { vs: seat } / 'vs:2' for "call vs jam".
 * frequency is the jam/call frequency; evGap is EV(jam or call) - EV(fold).
 */
export function nashAction(solution, { seat, node = 'open', handClass }) {
  const ci = toClassIndex(handClass);
  let id;
  if (node === 'open') id = `open:${seat}`;
  else {
    const jammer = typeof node === 'number' ? node : typeof node === 'object' ? node.vs : Number(String(node).replace(/^vs:/, ''));
    if (!Number.isInteger(jammer)) throw new Error(`Unknown node "${node}"`);
    id = `call:${jammer}:${seat}`;
  }
  const found = solution.nodes.find((x) => x.id === id);
  if (!found) throw new Error(`No decision "${id}" in this solution`);
  const frequency = found.strategy[ci];
  const aggressive = found.type === 'open' ? 'jam' : 'call';
  return { action: frequency >= 0.5 ? aggressive : 'fold', frequency, evGap: found.evGap[ci], unit: solution.unit };
}
