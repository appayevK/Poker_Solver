// Generic fictitious play / CFR loop over 169 hand classes.

/**
 * Iterate best responses until strategies converge.
 * @param {object} game - payoff functions per player
 * @returns strategies per player: Map handClass → action frequency
 */
export function solve(game, { iterations = 2000, tolerance = 1e-4 } = {}) {
  // TODO
}
