// Independent Chip Model (Malmuth-Harville), memoised over remaining-player subsets.
//
// Malmuth-Harville: a player finishes 1st with probability stack / total chips; the
// next place is then drawn the same way from the players left. finishProbabilities
// walks the sets of players already placed as bitmasks (each set's probability is
// computed once), which is O(2^n * n) and fast up to 12 players.
//
// Spot maths (spotEV and friends) work in $: every outcome of a hero-vs-villain
// all-in (hero folds, villain folds, called and win / lose / tie) becomes a new stack
// vector that is scored with icmEquity. Antes and the blinds of players who fold are
// dead money. When hero folds, the pot goes to villain (as when it is folded to the
// big blind); other players are assumed to fold.

import { bountyDollarValue } from './pko.js';

export const MAX_ICM_PLAYERS = 12;

function checkNumber(name, value, min = 0, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number (got ${value})`);
  }
  if (value < min || value > max) {
    throw new Error(
      max === Infinity ? `${name} must be at least ${min} (got ${value})` : `${name} must be between ${min} and ${max} (got ${value})`,
    );
  }
  return value;
}

function checkStacks(stacks) {
  if (!Array.isArray(stacks) || stacks.length === 0) throw new Error('Stacks must be a non-empty array');
  if (stacks.length > MAX_ICM_PLAYERS) {
    throw new Error(`ICM handles up to ${MAX_ICM_PLAYERS} players; enter only the players at the final table`);
  }
  stacks.forEach((s, i) => checkNumber(`Stack of player ${i + 1}`, s));
  if (!stacks.some((s) => s > 0)) throw new Error('At least one player needs chips');
}

/** Validates payouts in $ (or any unit): non-negative, non-increasing, total above 0. */
export function checkPayouts(payouts) {
  if (!Array.isArray(payouts) || payouts.length === 0) throw new Error('Payouts must be a non-empty array');
  payouts.forEach((p, i) => checkNumber(`Payout for place ${i + 1}`, p));
  for (let i = 1; i < payouts.length; i++) {
    if (payouts[i] > payouts[i - 1] + 1e-9) {
      throw new Error(`Payout for place ${i + 1} is larger than for place ${i}; list payouts from 1st down`);
    }
  }
  if (!(payouts.reduce((a, b) => a + b, 0) > 0)) throw new Error('Payouts must add up to more than 0');
  return payouts;
}

/**
 * Converts payouts given as % of the prize pool into amounts. The percentages may
 * cover only part of the pool (e.g. the final-table share) but cannot exceed 100%.
 */
export function payoutsFromPercent(percents, prizePool) {
  checkNumber('Prize pool', prizePool);
  if (prizePool === 0) throw new Error('Prize pool must be greater than 0');
  checkPayouts(percents);
  const total = percents.reduce((a, b) => a + b, 0);
  if (total > 100 + 1e-6) throw new Error(`Payout percentages add up to ${+total.toFixed(4)}%, more than 100%`);
  return percents.map((p) => (p / 100) * prizePool);
}

/**
 * Probability of each player finishing in each of the first `places` places:
 * matrix [player][place] (place 0 = 1st). Players with 0 chips are already out
 * and get 0 for every place.
 */
export function finishProbabilities(stacks, places = stacks.length) {
  checkStacks(stacks);
  if (!Number.isInteger(places) || places < 1) throw new Error(`Places must be a positive integer (got ${places})`);
  const n = stacks.length;
  const result = Array.from({ length: n }, () => new Array(places).fill(0));
  const active = [];
  for (let i = 0; i < n; i++) if (stacks[i] > 0) active.push(i);
  const m = active.length;
  const s = active.map((i) => stacks[i]);
  const total = s.reduce((a, b) => a + b, 0);
  const limit = Math.min(places, m);
  const size = 1 << m;

  const placedChips = new Float64Array(size); // chips of the players in each placed set
  const popcount = new Uint8Array(size);
  for (let mask = 1; mask < size; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    placedChips[mask] = placedChips[mask & (mask - 1)] + s[low];
    popcount[mask] = popcount[mask & (mask - 1)] + 1;
  }

  // prob[mask] = probability that exactly the players in mask took places 1..|mask|.
  const prob = new Float64Array(size);
  prob[0] = 1;
  for (let mask = 0; mask < size; mask++) {
    const p = prob[mask];
    const place = popcount[mask];
    if (p === 0 || place >= limit) continue;
    const remaining = total - placedChips[mask];
    for (let j = 0; j < m; j++) {
      const bit = 1 << j;
      if (mask & bit) continue;
      const q = (p * s[j]) / remaining;
      result[active[j]][place] += q;
      prob[mask | bit] += q;
    }
  }
  return result;
}

/**
 * $EV for each player given stacks and payouts (amounts per place, 1st first; there
 * may be fewer payouts than players). Players with 0 chips get 0.
 */
export function icmEquity(stacks, payouts) {
  checkPayouts(payouts);
  const probs = finishProbabilities(stacks, payouts.length);
  return probs.map((row) => row.reduce((ev, p, place) => ev + p * payouts[place], 0));
}

// ---------------------------------------------------------------------------
// Hero vs villain all-in spots

function checkSeat(name, seat, n) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= n) throw new Error(`${name} must be a seat from 1 to ${n}`);
}

/**
 * Builds the outcome stack vectors of a spot and scores them for hero, in $ (ICM
 * plus PKO cash) and in chips. Equity, tie and foldFreq are not needed here.
 */
function scoreSpot(spot) {
  const {
    stacks,
    payouts,
    blinds = {},
    sbSeat,
    bbSeat,
    posted,
    hero,
    villain,
    action = 'call',
    bounties,
    pko,
  } = spot;
  checkStacks(stacks);
  checkPayouts(payouts);
  const n = stacks.length;
  checkSeat('Hero', hero, n);
  checkSeat('Villain', villain, n);
  if (hero === villain) throw new Error('Hero and villain must be different players');
  if (stacks[hero] <= 0) throw new Error('Hero has no chips');
  if (stacks[villain] <= 0) throw new Error('Villain has no chips');
  if (action !== 'jam' && action !== 'call') throw new Error(`Action must be 'jam' or 'call' (got ${action})`);

  const { sb = 0, bb = 0, ante = 0, bbAnte = false } = blinds;
  checkNumber('Small blind', sb);
  checkNumber('Big blind', bb);
  checkNumber('Ante', ante);
  for (const [name, seat] of [['SB seat', sbSeat], ['BB seat', bbSeat]]) {
    if (seat === undefined || seat === null) continue;
    checkSeat(name, seat, n);
    if (stacks[seat] <= 0) throw new Error(`${name} player has no chips`);
  }
  if (sbSeat != null && sbSeat === bbSeat) throw new Error('Small blind and big blind must be different players');

  // Antes are dead money; blinds (or explicit posted amounts) are live.
  const dead = new Array(n).fill(0);
  const live = new Array(n).fill(0);
  if (ante > 0) {
    if (bbAnte) {
      if (bbSeat == null) throw new Error('A big blind ante needs a BB seat');
      dead[bbSeat] = Math.min(ante, stacks[bbSeat]);
    } else {
      for (let i = 0; i < n; i++) if (stacks[i] > 0) dead[i] = Math.min(ante, stacks[i]);
    }
  }
  if (posted) {
    if (!Array.isArray(posted) || posted.length !== n) throw new Error('posted must list one amount per player');
    posted.forEach((p, i) => {
      checkNumber(`Posted chips of player ${i + 1}`, p);
      if (p > stacks[i] - dead[i] + 1e-9) throw new Error(`Player ${i + 1} posted more than their stack`);
      live[i] = p;
    });
  } else {
    if (sbSeat != null) live[sbSeat] = Math.min(sb, stacks[sbSeat] - dead[sbSeat]);
    if (bbSeat != null) live[bbSeat] = Math.min(bb, stacks[bbSeat] - dead[bbSeat]);
  }

  const S = stacks;
  const h = hero;
  const v = villain;
  const base = S.map((s, i) => s - dead[i] - live[i]);
  let deadOthers = 0;
  for (let i = 0; i < n; i++) if (i !== h && i !== v) deadOthers += dead[i] + live[i];

  const heroFolds = base.slice();
  heroFolds[v] = S[v] + deadOthers + dead[h] + live[h];
  const villainFolds = base.slice();
  villainFolds[h] = S[h] + deadOthers + dead[v] + live[v];
  const matched = Math.min(S[h] - dead[h], S[v] - dead[v]); // live chips each side puts in
  const pot = deadOthers + dead[h] + dead[v] + 2 * matched;
  const heroLeft = S[h] - dead[h] - matched;
  const villainLeft = S[v] - dead[v] - matched;
  const win = base.slice();
  win[h] = heroLeft + pot;
  win[v] = villainLeft;
  const lose = base.slice();
  lose[h] = heroLeft;
  lose[v] = villainLeft + pot;
  const tie = base.slice();
  tie[h] = heroLeft + pot / 2;
  tie[v] = villainLeft + pot / 2;

  // Hero's $EV for a final stack vector; a busted hero takes the highest place left.
  const dollars = (vector) => {
    if (vector[h] > 0) return icmEquity(vector, payouts)[h];
    const ahead = vector.filter((x) => x > 0).length;
    return payouts[ahead] ?? 0;
  };

  let bountyCash = 0;
  if (pko && villainLeft === 0) {
    if (!Array.isArray(bounties) || bounties.length !== n) throw new Error('PKO needs one bounty per player');
    const headValueFactor = typeof pko === 'object' ? pko.headValueFactor ?? 0 : 0;
    bountyCash = bountyDollarValue({ bounty: checkNumber('Villain bounty', bounties[v]), headValueFactor });
  }

  return {
    action,
    vectors: { heroFolds, villainFolds, win, lose, tie },
    dollars: {
      heroFolds: dollars(heroFolds),
      villainFolds: dollars(villainFolds),
      win: dollars(win) + bountyCash,
      lose: dollars(lose),
      tie: dollars(tie),
    },
    chips: { heroFolds: heroFolds[h], villainFolds: villainFolds[h], win: win[h], lose: lose[h], tie: tie[h] },
    pot,
    matched,
    heroCovers: villainLeft === 0,
    bountyCash,
  };
}

/** Value of the action at a given equity / tie / fold frequency, from outcome values. */
function actionValue(values, action, equity, tie, foldFreq) {
  const winP = equity - tie / 2;
  const loseP = 1 - equity - tie / 2;
  const called = winP * values.win + tie * values.tie + loseP * values.lose;
  const f = action === 'jam' ? foldFreq : 0;
  return f * values.villainFolds + (1 - f) * called;
}

/** Equity at which the action's value equals folding (the value is linear in equity). */
function solveRequired(values, action, tie, foldFreq) {
  const f = action === 'jam' ? foldFreq : 0;
  const v0 = actionValue(values, action, 0, tie, f);
  const v1 = actionValue(values, action, 1, tie, f);
  if (Math.abs(v1 - v0) < 1e-12) return null; // equity does not matter (e.g. villain always folds)
  return (values.heroFolds - v0) / (v1 - v0);
}

function checkSpotProbabilities({ equity, tie = 0, foldFreq = 0 }) {
  checkNumber('Equity', equity, 0, 1);
  checkNumber('Tie probability', tie, 0, 1);
  checkNumber('Fold frequency', foldFreq, 0, 1);
  if (equity < tie / 2 - 1e-12 || equity > 1 - tie / 2 + 1e-12) {
    throw new Error('Equity must be between tie / 2 and 1 - tie / 2');
  }
}

/**
 * $EV of folding vs taking the action, for hero in an all-in spot.
 *
 * spot = {
 *   stacks,            chips per seat at the start of the hand (before blinds and antes)
 *   payouts,           $ per place, 1st first
 *   blinds,            { sb, bb, ante, bbAnte }: ante per player, or one ante posted by the BB
 *   sbSeat, bbSeat,    seats posting the blinds (optional)
 *   posted,            optional live chips per seat already in (overrides sb/bb)
 *   hero, villain,     seat indices
 *   action,            'jam' (hero shoves, villain calls or folds) | 'call' (villain shoved)
 *   equity, tie,       hero's equity when called, and the chance of a split pot (default 0)
 *   foldFreq,          for 'jam': how often villain folds
 *   bounties, pko,     PKO: $ bounty per seat, pko = true | { headValueFactor }
 * }
 * Returns { foldEV, actionEV, diff } in $, plus the same in chips under `chips`.
 *
 * PKO: when hero busts villain, villain's bounty / 2 (plus headValueFactor * bounty / 2)
 * is added to hero's $EV as cash. When a covering villain busts hero, hero's own bounty
 * goes to villain; that money was never hero's, so only the ICM part changes for hero.
 */
export function spotEV(spot) {
  checkSpotProbabilities(spot);
  const { equity, tie = 0, foldFreq = 0 } = spot;
  const scored = scoreSpot(spot);
  const result = (values) => {
    const foldEV = values.heroFolds;
    const actionEV = actionValue(values, scored.action, equity, tie, foldFreq);
    return { foldEV, actionEV, diff: actionEV - foldEV };
  };
  return { ...result(scored.dollars), chips: result(scored.chips), heroCovers: scored.heroCovers, pot: scored.pot };
}

/**
 * Equity at which the call or jam has the same $EV as folding, solved directly from
 * the linear $EV (tie and foldFreq held fixed). Values above 1 mean the action never
 * pays; below 0, it always does. Returns null when equity does not change the $EV.
 */
export function icmRequiredEquity(spot) {
  const { tie = 0, foldFreq = 0 } = spot;
  return solveRequired(scoreSpot(spot).dollars, spot.action ?? 'call', tie, foldFreq);
}

/** Chip-EV required equity for the same spot (bounties ignored). */
export function chipRequiredEquity(spot) {
  const { tie = 0, foldFreq = 0 } = spot;
  return solveRequired(scoreSpot(spot).chips, spot.action ?? 'call', tie, foldFreq);
}

/**
 * Extra equity required under ICM vs chip EV for the same spot:
 * icmRequiredEquity - chipRequiredEquity. With `pko` set the bounty is part of the
 * ICM side, so a big bounty can make this negative. Null if either is undefined.
 */
export function riskPremium(spot) {
  const icm = icmRequiredEquity(spot);
  const chip = chipRequiredEquity(spot);
  return icm === null || chip === null ? null : icm - chip;
}

/**
 * $EV of a jam/call decision: weighted over outcomes (fold / call-win / call-lose).
 * Thin wrapper around spotEV: `risk` is the action that risks hero's stack ('call' or
 * 'jam') and `outcomes` = { equity, tie, foldFreq }. Other spotEV options pass through.
 */
export function icmDecisionEV({ stacks, payouts, hero, villain, risk = 'call', outcomes = {}, ...rest }) {
  return spotEV({ ...rest, stacks, payouts, hero, villain, action: risk, ...outcomes });
}
