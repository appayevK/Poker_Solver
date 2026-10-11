// Flop spots: data/flops/spots.json resolved against the baseline preflop chart.
//
// The JSON only names the chart spot and action each range comes from; ranges, pot
// and effective stack are computed from the chart, so changing the chart changes the
// spots. Pot = both players' preflop money + blinds of players who folded (dead);
// stack = starting stack - money put in preflop. Amounts are in big blinds.
// A spot the chart can't describe (another stack depth, antes) can instead give its own
// "stack", "invested" (each player's preflop money), "dead" (folded blinds + antes) and
// ranges as strings: { "range": "22+,A2s+,..." }.

import spotsData from '../../data/flops/spots.json' with { type: 'json' };
import { loadChart, spotFrequencies } from '../preflop/charts.js';
import { spotSizes } from '../preflop/checks.js';
import { handClasses, parseRange, comboWeight } from '../engine/ranges.js';
import { CLASS_COMBOS, COMBO_CARDS } from '../engine/combos.js';

const CLASSES = handClasses();
const BLINDS = { SB: 0.5, BB: 1 };

export const SPOT_DEFINITIONS = spotsData.spots;

/** Money each player has in preflop and the dead blinds, from the chart's sizes. */
export function preflopMoney(def, chart) {
  let invested;
  if (def.type === 'SRP') {
    const opener = def.aggressor === 'ip' ? def.ip : def.oop;
    invested = spotSizes(chart, `RFI:${opener}`).open;
  } else if (def.type === '3BP') {
    const threeBettor = def.aggressor === 'ip' ? def.ip : def.oop;
    const opener = def.aggressor === 'ip' ? def.oop : def.ip;
    invested = spotSizes(chart, `vsOpen:${threeBettor}:${opener}`).threeBet;
  } else {
    throw new Error(`Unknown spot type ${def.type}`);
  }
  let dead = 0;
  for (const [pos, blind] of Object.entries(BLINDS)) if (pos !== def.ip && pos !== def.oop) dead += blind;
  return { invested, dead };
}

/** Class-level range (Float64Array(169)) for a { spot, action } chart reference or a { range } string. */
function rangeFrom(chart, ref) {
  if (ref.range != null) {
    const range = parseRange(ref.range);
    return Float64Array.from(CLASS_COMBOS, (combos) => combos.reduce((sum, i) => sum + comboWeight(range, COMBO_CARDS[2 * i], COMBO_CARDS[2 * i + 1]), 0) / combos.length);
  }
  const freqs = spotFrequencies(chart, ref.spot);
  if (!freqs[ref.action]) throw new Error(`Unknown action ${ref.action}`);
  return Float64Array.from(freqs[ref.action]);
}

/** Range in TexasSolver's syntax: comma-separated classes with optional ":weight" (3 decimals). */
export function solverRange(range) {
  const parts = [];
  for (let c = 0; c < 169; c++) {
    const w = Math.round(range[c] * 1000) / 1000;
    if (w <= 0) continue;
    parts.push(w >= 1 ? CLASSES[c] : `${CLASSES[c]}:${w}`);
  }
  return parts.join(',');
}

/** A spot definition with pot, stack and both ranges from the chart. */
export function resolveSpot(def, chart = loadChart(spotsData.chart)) {
  const { invested, dead } = def.invested != null ? { invested: def.invested, dead: def.dead ?? 0 } : preflopMoney(def, chart);
  const startStack = def.stack ?? spotsData.stack ?? chart.stack;
  return {
    ...def,
    pot: 2 * invested + dead,
    stack: startStack - invested,
    invested,
    dead,
    ranges: { ip: rangeFrom(chart, def.ranges.ip), oop: rangeFrom(chart, def.ranges.oop) },
  };
}

/** Every spot resolved against the baseline chart. */
export function allSpots(chart) {
  return SPOT_DEFINITIONS.map((def) => resolveSpot(def, chart));
}

/** One resolved spot by id. */
export function getSpot(id, chart) {
  const def = SPOT_DEFINITIONS.find((s) => s.id === id);
  if (!def) throw new Error(`Unknown flop spot "${id}"`);
  return resolveSpot(def, chart);
}
