// Whole-hand review: states, one analysis per hero decision and the leak flags.
//
// Villain ranges come from the user's saved ranges (hand.ranges[actionIndex] =
// { villain, range }) or else from the defaults in default-ranges.js; each analysis
// records which (rangeSource), so flags built on a default postflop range say so.

import { buildStates, analyseDecision, heroDecisions, mainVillain } from './replayer.js';
import { defaultVillainRange } from './default-ranges.js';
import { detectLeaks, oversizedJams } from './leak-flags.js';

/** The villain and range used at a hero decision: { villain, range, label, source }. */
export function rangeFor(hand, state, saved = hand.ranges?.[state.actionIndex]) {
  const open = state.street === 'preflop' && !state.facing;
  const villain = saved?.villain !== undefined ? saved.villain : open ? null : mainVillain(hand, state);
  if (!villain) return { villain: null, range: null, label: null, source: null };
  const def = defaultVillainRange(hand, villain, state.actionIndex);
  if (saved?.range && saved.villain === villain) return { villain, range: saved.range, label: def.label, source: 'user' };
  return { villain, range: def.range, label: def.label, source: def.source === 'chart' ? 'chart' : 'default' };
}

/**
 * Analyses every hero decision. options: { foldFreq: { [actionIndex]: 0-1 }, equityFn,
 * nashFn, leakOptions }. Returns { states, analyses, flags }.
 */
export async function analyseHand(hand, { foldFreq = {}, equityFn, nashFn, leakOptions } = {}) {
  const states = buildStates(hand);
  const analyses = [];
  for (const s of heroDecisions(states)) {
    const r = rangeFor(hand, s);
    const an = await analyseDecision(s, { hand, villain: r.villain, villainRange: r.range, foldFreq: foldFreq[s.actionIndex] ?? 0.4, equityFn, nashFn });
    analyses.push({ ...an, villainRange: r.range, rangeLabel: r.label, rangeSource: r.source === 'user' ? 'user' : 'default', rangeFrom: r.source });
  }
  return { states, analyses, flags: detectLeaks(hand, states, analyses, leakOptions) };
}

/** Flags that need no equity (used at import, before a hand is analysed). */
export function quickFlags(hand) {
  return oversizedJams(hand, buildStates(hand));
}
