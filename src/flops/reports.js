// Texture reports: a spot's action frequencies at one node, aggregated by texture
// group over the solved flops, plus plain-language takeaways.
// Flops are weighted by how many real flops they stand for (`raw` in the subset), since
// boards come up in proportion to raw counts; canonical counts (`weight`) would make
// rare textures like monotone boards look three times more common than they are.
// Each flop also counts by how often the decision comes up there (`line`): "BTN vs check"
// on a board where BB bets every hand is a strategy nobody plays, and should not drag
// the texture's average.

import { TEXTURE_GROUPS } from './texture.js';

/** Rows where the decision comes up less often than this are too rare to read much into. */
export const RARE_LINE = 0.05;

/**
 * { actions: [{ key, label }], rows: [{ group, flops, share, reach, freqs: { key: f } }],
 *   overall: { flops, reach, freqs } } for the node `nodeId` of spot `spotId` in the index.
 * share = the texture's part of all boards; reach = how often the decision comes up on it.
 */
export function textureReport(index, spotId, nodeId) {
  const spot = index.spots.find((s) => s.id === spotId);
  const actions = [];
  const byGroup = new Map();
  let total = 0;
  let totalReached = 0;
  const overall = {};
  let overallFlops = 0;
  for (const flop of spot?.flops ?? []) {
    const node = flop.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    for (const a of node.actions) if (!actions.some((x) => x.key === a.key)) actions.push({ key: a.key, label: a.label.replace(/ \([\d.]+bb\)$/, '') });
    const g = byGroup.get(flop.group) ?? { group: flop.group, flops: 0, weight: 0, reached: 0, sums: {} };
    const reached = flop.raw * (node.line ?? 1);
    g.flops++;
    g.weight += flop.raw;
    g.reached += reached;
    node.actions.forEach((a, i) => {
      g.sums[a.key] = (g.sums[a.key] ?? 0) + reached * node.summary[i];
      overall[a.key] = (overall[a.key] ?? 0) + reached * node.summary[i];
    });
    byGroup.set(flop.group, g);
    total += flop.raw;
    totalReached += reached;
    overallFlops++;
  }
  const rows = TEXTURE_GROUPS.filter((g) => byGroup.has(g)).map((name) => {
    const g = byGroup.get(name);
    return {
      group: name,
      flops: g.flops,
      share: total ? g.weight / total : 0,
      reach: g.weight ? g.reached / g.weight : 0,
      freqs: Object.fromEntries(actions.map((a) => [a.key, g.reached ? (g.sums[a.key] ?? 0) / g.reached : 0])),
    };
  });
  return {
    actions,
    rows,
    overall: {
      flops: overallFlops,
      reach: total ? totalReached / total : 0,
      freqs: Object.fromEntries(actions.map((a) => [a.key, totalReached ? (overall[a.key] ?? 0) / totalReached : 0])),
    },
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Short plain-language takeaways from a report, e.g.
 * "BTN bets 85% on A-high dry (mostly Bet 33%), but only 48% on Middle wet."
 * actor: the player at the node (e.g. 'BTN'). Textures where the decision rarely comes
 * up (reach under RARE_LINE) are left out of the comparisons.
 */
export function takeaways(report, actor) {
  const { actions } = report;
  if (!report.rows.length) return [];
  const rows = report.rows.filter((r) => (r.reach ?? 1) >= RARE_LINE);
  if (!rows.length) {
    const reach = report.overall.reach ?? 0;
    return [`This decision ${reach < 0.005 ? 'almost never comes up' : `comes up only ${pct(reach)} of the time`} on these boards, so its mix tells you little.`];
  }
  const out = [];
  const keys = actions.map((a) => a.key);
  const label = (key) => actions.find((a) => a.key === key)?.label ?? key;
  const aggressive = keys.filter((k) => /^bet|^raise|^allin/.test(k));
  const passive = keys.includes('check') ? 'check' : null;
  const sumOf = (row, ks) => ks.reduce((s, k) => s + (row.freqs[k] ?? 0), 0);

  if (aggressive.length && (passive || keys.includes('call'))) {
    const scored = rows.map((r) => ({ r, agg: sumOf(r, aggressive) })).sort((a, b) => b.agg - a.agg);
    const top = scored[0];
    const bottom = scored[scored.length - 1];
    const main = (r) => aggressive.reduce((best, k) => ((r.freqs[k] ?? 0) > (r.freqs[best] ?? 0) ? k : best), aggressive[0]);
    const verb = passive ? 'bets' : 'raises';
    if (scored.length > 1 && top.agg - bottom.agg > 0.05) {
      out.push(
        `${actor} ${verb} ${pct(top.agg)} on ${top.r.group}${aggressive.length > 1 ? ` (mostly ${lower(label(main(top.r)))})` : ''}, but only ${pct(bottom.agg)} on ${bottom.r.group}.`,
      );
    } else {
      out.push(`${actor} ${verb} about ${pct(top.agg)} on every texture.`);
    }
    if (aggressive.filter((k) => k.startsWith('bet')).length > 1) {
      const big = aggressive.filter((k) => /^bet(\d+)$/.test(k)).sort((a, b) => Number(b.slice(3)) - Number(a.slice(3)))[0];
      const share = (r) => {
        const agg = sumOf(r, aggressive);
        return agg > 0.02 ? (r.freqs[big] ?? 0) / agg : 0;
      };
      const best = rows.reduce((a, b) => (share(b) > share(a) ? b : a));
      if (share(best) > 0.25) out.push(`The big ${label(big).toLowerCase().replace(/^bet /, '')} bet is used most on ${best.group}, for ${pct(share(best))} of ${actor}'s bets there.`);
    }
  }
  if (passive) {
    const most = rows.reduce((a, b) => ((b.freqs[passive] ?? 0) > (a.freqs[passive] ?? 0) ? b : a));
    if ((most.freqs[passive] ?? 0) > 0.4) out.push(`${actor} checks most on ${most.group} (${pct(most.freqs[passive])}).`);
  }
  if (keys.includes('fold')) {
    const sorted = [...rows].sort((a, b) => (b.freqs.fold ?? 0) - (a.freqs.fold ?? 0));
    const hi = sorted[0];
    const lo = sorted[sorted.length - 1];
    if (sorted.length > 1 && (hi.freqs.fold ?? 0) - (lo.freqs.fold ?? 0) > 0.05) {
      out.push(`${actor} folds most on ${hi.group} (${pct(hi.freqs.fold)}) and least on ${lo.group} (${pct(lo.freqs.fold)}).`);
    } else out.push(`${actor} folds about ${pct(hi.freqs.fold ?? 0)} on every texture.`);
  }
  const rare = report.rows.filter((r) => !rows.includes(r));
  if (rare.length) out.push(`Left out because this decision rarely comes up there: ${rare.map((r) => `${r.group} (${pct(r.reach)})`).join(', ')}.`);
  return out;
}
