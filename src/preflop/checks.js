// Range checks for preflop chart spots: defence vs MDF, bluff break-even fold
// frequencies vs what the chart folds, and card-removal (blocker) effects.
// Amounts are in big blinds and follow the chart's sizes; blinds are 0.5 / 1, no antes.

import { breakEvenFoldFreq, mdf } from '../calc/ev.js';
import { handClasses, classIndex } from '../engine/ranges.js';
import { PAIRS, CLASS_COMBO_COUNTS } from '../nash/card-removal.js';
import { parseSpotId, spotFrequencies, POSITIONS } from './charts.js';

const CLASSES = handClasses();
const POSTFLOP_ORDER = ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'];
const BLINDS = 1.5;

const posted = (pos) => (pos === 'SB' ? 0.5 : pos === 'BB' ? 1 : 0);
/** True when a acts after b on later streets. */
export const inPosition = (a, b) => POSTFLOP_ORDER.indexOf(a) > POSTFLOP_ORDER.indexOf(b);
const openSize = (chart, pos) => (pos === 'SB' ? chart.sizes.sbOpen : chart.sizes.open);

/** Rough strength order for listing hands: pairs by rank, then by high card, kicker, suitedness. */
function strength(cls) {
  const rank = (ch) => '23456789TJQKA'.indexOf(ch);
  if (cls.length === 2) return 200 + rank(cls[0]);
  return rank(cls[0]) * 13 + rank(cls[1]) + (cls[2] === 's' ? 0.5 : 0);
}

/** Share of all 1326 combos a class-frequency vector covers. */
function share(freqs) {
  let total = 0;
  for (let c = 0; c < 169; c++) total += freqs[c] * CLASS_COMBO_COUNTS[c];
  return total / 1326;
}

function continuing(f) {
  return f.raise.map((r, c) => r + f.call[c] + f.allin[c]);
}

/** Raise sizes in a spot, in bb (open, 3-bet and 4-bet "to" amounts). */
export function spotSizes(chart, spotId) {
  const s = parseSpotId(spotId);
  if (s.type === 'RFI') return { open: openSize(chart, s.hero) };
  if (s.type === 'vsOpen') {
    const open = openSize(chart, s.villain);
    const ip = inPosition(s.hero, s.villain);
    return { open, threeBet: open * (ip ? chart.sizes.threeBetIP : chart.sizes.threeBetOOP), heroInPosition: ip };
  }
  const open = openSize(chart, s.hero);
  const threeBettorIP = inPosition(s.villain, s.hero);
  const threeBet = open * (threeBettorIP ? chart.sizes.threeBetIP : chart.sizes.threeBetOOP);
  return { open, threeBet, fourBet: threeBet * chart.sizes.fourBet, heroInPosition: !threeBettorIP };
}

/**
 * Facing an open: hero's defence (call + 3-bet) vs the minimum defence frequency
 * against the open size. MDF = pot / (pot + bet) with the blinds as the pot and the
 * opener's added chips as the bet. Returns shares of all hands (0..1).
 */
export function defendCheck(chart, spotId) {
  const s = parseSpotId(spotId);
  if (s.type !== 'vsOpen') throw new Error('defendCheck needs a vsOpen spot');
  const open = openSize(chart, s.villain);
  const bet = open - posted(s.villain);
  const f = spotFrequencies(chart, spotId);
  const defend = share(continuing(f));
  const value = mdf(BLINDS, bet);
  const behind = POSITIONS.slice(POSITIONS.indexOf(s.hero) + 1).length;
  return {
    open,
    pot: BLINDS,
    bet,
    mdf: value,
    defend,
    threeBet: share(f.raise),
    call: share(f.call) + share(f.allin),
    playersBehind: behind,
  };
}

/**
 * Bluff check for the raise in a spot. vsOpen: hero's 3-bet; vs3bet: hero's 4-bet.
 * breakEven is the fold frequency a pure bluff needs (risk / (pot + risk)).
 * opponentFolds is the share of the opponent's range that folds according to the
 * chart (for a 3-bet: the opener's vs-3-bet spot), or null when the chart has no
 * response spot (the format has no vs-4-bet spots).
 */
export function bluffCheck(chart, spotId) {
  const s = parseSpotId(spotId);
  if (s.type === 'vsOpen') {
    const sizes = spotSizes(chart, spotId);
    const pot = BLINDS + sizes.open - posted(s.villain);
    const risk = sizes.threeBet - posted(s.hero);
    const response = `vs3bet:${s.villain}:${s.hero}`;
    let opponentFolds = null;
    if (chart.spots[response] && chart.spots[`RFI:${s.villain}`]) {
      const opens = spotFrequencies(chart, `RFI:${s.villain}`).raise;
      const cont = continuing(spotFrequencies(chart, response));
      const opened = share(opens);
      opponentFolds = opened > 0 ? 1 - share(cont) / opened : null;
    }
    return { kind: '3-bet', size: sizes.threeBet, pot, risk, breakEven: breakEvenFoldFreq(pot, risk), opponentFolds, responseSpot: response };
  }
  if (s.type === 'vs3bet') {
    const sizes = spotSizes(chart, spotId);
    const pot = BLINDS + sizes.open - posted(s.hero) + sizes.threeBet - posted(s.villain);
    const risk = sizes.fourBet - sizes.open;
    return { kind: '4-bet', size: sizes.fourBet, pot, risk, breakEven: breakEvenFoldFreq(pot, risk), opponentFolds: null, responseSpot: null };
  }
  throw new Error('bluffCheck needs a vsOpen or vs3bet spot');
}

/**
 * Card-removal effect of holding heroClass when raising in a spot. For a 3-bet: the
 * opener's fold share to the 3-bet given hero's hand vs on average. For a 4-bet: how
 * much of the 3-bettor's range hero's hand removes. `blocks` lists the opponent
 * classes sharing a rank with hero's hand: combos left per hero combo vs in the deck.
 */
export function blockerEffect(chart, spotId, heroClass) {
  const h = classIndex(heroClass);
  if (h < 0) throw new Error(`Unknown hand class "${heroClass}"`);
  const s = parseSpotId(spotId);
  let range;
  let folds = null;
  if (s.type === 'vsOpen') {
    range = spotFrequencies(chart, `RFI:${s.villain}`).raise;
    const response = `vs3bet:${s.villain}:${s.hero}`;
    if (chart.spots[response]) {
      const cont = continuing(spotFrequencies(chart, response));
      folds = range.map((r, c) => Math.max(0, r - cont[c]));
    }
  } else if (s.type === 'vs3bet') {
    range = spotFrequencies(chart, `vsOpen:${s.villain}:${s.hero}`).raise;
  } else {
    throw new Error('blockerEffect needs a vsOpen or vs3bet spot');
  }

  const nh = CLASS_COMBO_COUNTS[h];
  let withHand = 0;
  let average = 0;
  let foldWith = 0;
  let foldAverage = 0;
  for (let v = 0; v < 169; v++) {
    const pairs = PAIRS[h * 169 + v] / nh; // opponent combos left per hero combo
    const plain = (CLASS_COMBO_COUNTS[v] * 1225) / 1326; // expected combos left for a random hero hand
    withHand += range[v] * pairs;
    average += range[v] * plain;
    if (folds) {
      foldWith += folds[v] * pairs;
      foldAverage += folds[v] * plain;
    }
  }
  const ranks = new Set(heroClass.slice(0, 2));
  const blocks = [];
  for (let v = 0; v < 169; v++) {
    if (range[v] <= 0 || ![...CLASSES[v].slice(0, 2)].some((r) => ranks.has(r))) continue;
    blocks.push({ handClass: CLASSES[v], remaining: PAIRS[h * 169 + v] / nh, total: CLASS_COMBO_COUNTS[v], weight: range[v] });
  }
  blocks.sort((a, b) => strength(b.handClass) - strength(a.handClass));
  return {
    heroClass,
    rangeRemoved: average > 0 ? 1 - withHand / average : 0,
    foldShareWith: folds && withHand > 0 ? foldWith / withHand : null,
    foldShareAverage: folds && average > 0 ? foldAverage / average : null,
    blocks: blocks.slice(0, 8),
  };
}
