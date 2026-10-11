// Flop trainer: deals a spot, flop, decision node and hand from the solved library and
// scores answers against the solver's mix (same thresholds as the preflop trainer:
// correct at 50%+, acceptable at 15-50%, wrong otherwise).
//
// Flops are drawn in proportion to the real flops they stand for (`raw`), hands in
// proportion to the player's range at that node (preflop weight, and for OOP facing a
// bet also how often it checked). Decisions that come up less than RARE_LINE of the time
// on that flop (e.g. "BTN vs check" when BB bets every hand) are skipped: their mixes are
// barely tested by the solver. The board and hand get a random suit relabelling so the
// same stored flop shows up with different suits.

import { CORRECT_AT, ACCEPTABLE_AT, updateStats } from '../preflop/trainer.js';
import { SUIT_PERMS, mapCard } from './canonical.js';
import { dequantizeRow } from './codec.js';
import { RARE_LINE } from './reports.js';
import { parseCards, cardToString } from '../engine/cards.js';
import { COMBO_CARDS, COMBO_CLASS } from '../engine/combos.js';
import { handClasses } from '../engine/ranges.js';

const CLASSES = handClasses();

function pickWeighted(rng, items, weightOf) {
  const total = items.reduce((s, x) => s + weightOf(x), 0);
  let u = rng.float() * total;
  for (const x of items) {
    u -= weightOf(x);
    if (u <= 0) return x;
  }
  return items[items.length - 1];
}

/**
 * Deals a question. index: loadIndex(); loadFlop(spotId, key) → decoded flop data.
 * options: rng (createRng), spots (ids to use, default all with data).
 * Returns { spotId, spot, flop, group, label, board: [3 cards], node: { id, label, player },
 *   actions, hand: [2 cards], handClass, frequencies } (cards in the dealt suits).
 */
export async function dealFlopQuestion(index, loadFlop, { rng, spots } = {}) {
  const usable = index.spots.filter((s) => s.flops.length && (!spots || spots.includes(s.id)));
  if (!usable.length) throw new Error('No solved flops to train on yet: run the solve pipeline first');
  const spot = usable[rng.int(usable.length)];
  const flopInfo = pickWeighted(rng, spot.flops, (f) => f.raw);
  const data = await loadFlop(spot.id, flopInfo.key);
  const choices = data.nodes.filter((n) => n.actions.length > 1);
  const common = choices.filter((n) => (n.line ?? 1) >= RARE_LINE);
  const nodes = common.length ? common : choices;
  const node = nodes[rng.int(nodes.length)];
  const list = data.combos[node.player];
  const positions = Array.from(list, (_, c) => c).filter((c) => node.reach[c] > 0);
  const c = pickWeighted(rng, positions, (i) => node.reach[i]);
  const idx = list[c];
  const perm = SUIT_PERMS[rng.int(SUIT_PERMS.length)];
  const board = parseCards(flopInfo.key).map((card) => mapCard(card, perm));
  const hand = [mapCard(COMBO_CARDS[2 * idx], perm), mapCard(COMBO_CARDS[2 * idx + 1], perm)].sort((a, b) => b - a);
  const freqs = dequantizeRow(node.bytes, c * node.actions.length, node.actions.length);
  return {
    spotId: spot.id,
    spot,
    flop: flopInfo.key,
    group: flopInfo.group,
    label: flopInfo.label,
    board,
    node: { id: node.id, label: node.label, player: node.player },
    actions: node.actions,
    hand,
    handText: hand.map(cardToString).join(''),
    handClass: CLASSES[COMBO_CLASS[idx]],
    frequencies: freqs,
  };
}

/** Scores an answer (action index): { verdict, correct, frequency, best }. */
export function scoreFlopAnswer(question, actionIndex) {
  const f = question.frequencies;
  if (!(actionIndex >= 0 && actionIndex < f.length)) throw new Error(`No action ${actionIndex} at this node`);
  const frequency = f[actionIndex];
  const verdict = frequency >= CORRECT_AT - 1e-9 ? 'correct' : frequency >= ACCEPTABLE_AT - 1e-9 ? 'acceptable' : 'wrong';
  const best = f.reduce((b, x, i) => (x > f[b] ? i : b), 0);
  return { verdict, correct: verdict === 'correct', frequency, best };
}

/** Stats by spot and by texture group: { spots: {...}, groups: {...} } (preflop trainer format). */
export function updateFlopStats(stats, question, verdict) {
  const hand = { handClass: `${question.handText} on ${question.board.map(cardToString).join('')}` };
  return {
    spots: updateStats(stats.spots ?? {}, { ...hand, spotId: question.spotId }, verdict),
    groups: updateStats(stats.groups ?? {}, { ...hand, spotId: question.group }, verdict),
  };
}
