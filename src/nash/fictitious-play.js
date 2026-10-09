// Generic fictitious play over 169 hand classes.
//
// A game is a set of decision nodes (information sets). Each node belongs to one
// player and holds a 169-vector: the probability of the aggressive action (jam or
// call) per hand class; the other action is fold. The game supplies
//   evaluate(strategies) → { gaps, weights }
// where gaps[node][c] is EV(action) - EV(fold) for class c at that node, given every
// node's current strategy, and weights[node][c] is the probability of reaching the
// node holding c. Each iteration plays the best response at every node (action iff
// gap > 0) against the current average strategies, then moves the averages towards
// it by a step size:
//   'linear' (default)  2 / (t + 2): best response t has weight proportional to t, so
//                       the starting guess and early noise fade like 1 / t^2. On
//                       push/fold this reaches 1e-4 bb in a few hundred iterations
//                       where classic fictitious play needs tens of thousands;
//   '1/t'               classic fictitious play (plain average of all best responses);
//   'fixed'             a constant step (fast early, then plateaus near the step size).
//
// Exploitability of a player = sum over their nodes and classes of
//   weight * (max(gap, 0) - strategy * gap),
// the value a best response would gain against everyone else's strategies. This is
// the true best-response gain when each player acts at most once per hand (so their
// nodes are independent), as in push/fold.

/**
 * Iterate best responses until strategies converge.
 * @param {object} game - { players, nodes: [{ id, player }], evaluate(strategies) }
 * @param {object} options
 *   iterations  maximum iterations (default 2000)
 *   tolerance   stop when every player's exploitability is below this (default 1e-4)
 *   averaging   'linear' (default), '1/t' or 'fixed'
 *   step        step size for 'fixed' averaging (default 0.05)
 *   initial     optional starting strategies (array of 169-vectors)
 *   onProgress  optional callback({ iteration, exploitability }) every `progressEvery` iterations
 * @returns { strategies, exploitability: number[] per player, iterations, converged, gaps, weights }
 */
export function solve(
  game,
  { iterations = 2000, tolerance = 1e-4, averaging = 'linear', step = 0.05, initial, onProgress, progressEvery = 25 } = {},
) {
  const { nodes, players } = game;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('The game has no decision nodes');
  const stepSize = { linear: (t) => 2 / (t + 2), '1/t': (t) => 1 / (t + 1), fixed: () => step }[averaging];
  if (!stepSize) throw new Error(`Unknown averaging "${averaging}" (use linear, 1/t or fixed)`);
  const strategies = nodes.map((_, k) => Float64Array.from(initial?.[k] ?? new Float64Array(169).fill(0.5)));
  const exploitability = new Float64Array(players);

  const measure = () => {
    const result = game.evaluate(strategies);
    exploitability.fill(0);
    nodes.forEach((node, k) => {
      const gap = result.gaps[k];
      const weight = result.weights[k];
      const s = strategies[k];
      let gain = 0;
      for (let c = 0; c < gap.length; c++) gain += weight[c] * ((gap[c] > 0 ? gap[c] : 0) - s[c] * gap[c]);
      exploitability[node.player] += gain;
    });
    return result;
  };

  let result = measure();
  let t = 0;
  let converged = Math.max(...exploitability) < tolerance;
  while (!converged && t < iterations) {
    t++;
    const lr = stepSize(t);
    nodes.forEach((_, k) => {
      const gap = result.gaps[k];
      const s = strategies[k];
      for (let c = 0; c < s.length; c++) s[c] += lr * ((gap[c] > 0 ? 1 : 0) - s[c]);
    });
    result = measure();
    const worst = Math.max(...exploitability);
    converged = worst < tolerance;
    if (onProgress && (t % progressEvery === 0 || converged)) onProgress({ iteration: t, exploitability: worst });
  }

  return {
    strategies,
    exploitability: Array.from(exploitability),
    iterations: t,
    converged,
    gaps: result.gaps,
    weights: result.weights,
  };
}
