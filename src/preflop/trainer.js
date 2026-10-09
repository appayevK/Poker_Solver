// Preflop trainer: random spots, score answers against a chart.
//
// Scoring: an answer is
//   correct     if the chart plays it at least 50% of the time with this hand,
//   acceptable  if the chart plays it 15-50% of the time (a mixed hand),
//   wrong       otherwise.
// Hands are dealt by combo, so each class turns up in proportion to its combos
// (a pair 6/1326, a suited hand 4/1326, an offsuit hand 12/1326). Facing a 3-bet,
// hero can only hold a hand they opened, so those deals are also weighted by the
// chart's opening frequency for that hand.
// Spaced repetition: a hand answered wrong comes back 3 deals later; each correct
// answer on it doubles the gap, and it leaves the queue once the gap passes 24 deals.

import { handClasses } from '../engine/ranges.js';
import { COMBO_CARDS, CLASS_COMBOS, COMBO_CLASS } from '../engine/combos.js';
import { createRng, randomSeed } from '../engine/rng.js';
import { parseSpotId, spotFrequencies, chartAction, legalActions, ACTIONS, ALL_ACTIONS } from './charts.js';

const CLASSES = handClasses();
export const CORRECT_AT = 0.5;
export const ACCEPTABLE_AT = 0.15;
const REVIEW_FIRST_GAP = 3;
const REVIEW_MAX_GAP = 24;
const RECENT_MISTAKES = 10;

/**
 * Edge hands of a spot: mixed hands (no action at 100%) and hands next to the
 * boundary, i.e. with a grid neighbour whose main action differs. Returns a Set of
 * class names.
 */
export function edgeClasses(chart, spotId) {
  const f = spotFrequencies(chart, spotId);
  const main = new Array(169);
  const mixed = new Array(169);
  for (let c = 0; c < 169; c++) {
    let best = 'fold';
    let bestFreq = f.fold[c];
    for (const action of ACTIONS) {
      if (f[action][c] > bestFreq) {
        best = action;
        bestFreq = f[action][c];
      }
    }
    main[c] = best;
    mixed[c] = bestFreq < 0.999;
  }
  const edges = new Set();
  for (let c = 0; c < 169; c++) {
    const row = Math.floor(c / 13);
    const col = c % 13;
    const neighbours = [
      [row - 1, col],
      [row + 1, col],
      [row, col - 1],
      [row, col + 1],
    ].filter(([r, k]) => r >= 0 && r < 13 && k >= 0 && k < 13);
    if (mixed[c] || neighbours.some(([r, k]) => main[r * 13 + k] !== main[c])) edges.add(CLASSES[c]);
  }
  return edges;
}

/** A combo index drawn uniformly from the given classes' combos (all 1326 when null). */
function dealCombo(rng, classIndices) {
  if (!classIndices) return rng.int(1326);
  const combos = [];
  for (const c of classIndices) for (const i of CLASS_COMBOS[c]) combos.push(i);
  return combos[rng.int(combos.length)];
}

/**
 * Picks a spot and deals a hand.
 * options: rng (createRng(seed); default: random seed), spots (list of spot ids to
 * use; default: every spot in the chart), focus ('all' | 'edges'), review (spaced-
 * repetition queue from updateReview) and deal (the current deal number, for the queue).
 * Returns { spotId, type, hero, villain, handClass, cards: [c1, c2], legal, fromReview }.
 */
export function nextSpot(chart, { rng = createRng(randomSeed()), spots, focus = 'all', review = [], deal = 0 } = {}) {
  const allowed = (spots ?? Object.keys(chart.spots)).filter((id) => chart.spots[id]);
  if (allowed.length === 0) throw new Error('No spots to train: pick at least one spot that the chart covers');

  const due = review.find((item) => item.due <= deal && allowed.includes(item.spotId));
  let spotId;
  let classes;
  if (due) {
    spotId = due.spotId;
    classes = [CLASSES.indexOf(due.handClass)];
  } else {
    spotId = allowed[rng.int(allowed.length)];
    classes = null;
    if (focus === 'edges') {
      const edges = edgeClasses(chart, spotId);
      if (edges.size) classes = [...edges].map((cls) => CLASSES.indexOf(cls));
    }
  }
  const { type, hero, villain } = parseSpotId(spotId);
  const opens = !due && type === 'vs3bet' && chart.spots[`RFI:${hero}`] ? spotFrequencies(chart, `RFI:${hero}`) : null;
  let combo;
  for (let tries = 0; ; tries++) {
    combo = dealCombo(rng, classes);
    if (!opens || tries >= 5000) break;
    const c = COMBO_CLASS[combo];
    if (rng.float() < opens.raise[c] + opens.call[c] + opens.allin[c]) break;
  }
  const cards = [COMBO_CARDS[2 * combo], COMBO_CARDS[2 * combo + 1]];
  return { spotId, type, hero, villain, handClass: CLASSES[COMBO_CLASS[combo]], cards, legal: legalActions(chart, spotId), fromReview: !!due };
}

/**
 * Scores an answer ('fold' | 'call' | 'raise' | 'allin') for a dealt spot
 * ({ spotId, handClass }). Returns { correct, verdict: 'correct' | 'acceptable' |
 * 'wrong', frequency, frequencies, best } where frequencies are the chart's mix.
 */
export function scoreAnswer(chart, spot, answer) {
  if (!ALL_ACTIONS.includes(answer)) throw new Error(`Unknown answer "${answer}"`);
  const frequencies = chartAction(chart, spot.spotId, spot.handClass);
  const frequency = frequencies[answer];
  const verdict = frequency >= CORRECT_AT - 1e-9 ? 'correct' : frequency >= ACCEPTABLE_AT - 1e-9 ? 'acceptable' : 'wrong';
  const best = ALL_ACTIONS.reduce((a, b) => (frequencies[b] > frequencies[a] ? b : a));
  return { correct: verdict === 'correct', verdict, frequency, frequencies, best };
}

/**
 * Spaced-repetition queue update after an answer at deal number `deal`. Wrong answers
 * (re)enter with a 3-deal gap; correct ones on queued hands double the gap and drop
 * out past 24. Returns a new queue: [{ spotId, handClass, gap, due }].
 */
export function updateReview(review, spot, verdict, deal) {
  const same = (item) => item.spotId === spot.spotId && item.handClass === spot.handClass;
  const existing = review.find(same);
  const rest = review.filter((item) => !same(item));
  if (verdict === 'wrong') return [...rest, { spotId: spot.spotId, handClass: spot.handClass, gap: REVIEW_FIRST_GAP, due: deal + REVIEW_FIRST_GAP }];
  if (!existing) return rest;
  const gap = existing.gap * 2;
  return gap > REVIEW_MAX_GAP ? rest : [...rest, { ...existing, gap, due: deal + gap }];
}

/**
 * Per-spot stats update: { [spotId]: { attempts, correct, acceptable, wrong, recentMistakes } }.
 * Returns a new stats object.
 */
export function updateStats(stats, spot, verdict) {
  const prev = stats[spot.spotId] ?? { attempts: 0, correct: 0, acceptable: 0, wrong: 0, recentMistakes: [] };
  const next = { ...prev, attempts: prev.attempts + 1, [verdict]: prev[verdict] + 1 };
  if (verdict === 'wrong') next.recentMistakes = [spot.handClass, ...prev.recentMistakes.filter((h) => h !== spot.handClass)].slice(0, RECENT_MISTAKES);
  return { ...stats, [spot.spotId]: next };
}

/** Accuracy: correct answers count 1, acceptable ones 0.5. */
export function accuracy({ attempts, correct, acceptable }) {
  return attempts ? (correct + 0.5 * acceptable) / attempts : 0;
}
