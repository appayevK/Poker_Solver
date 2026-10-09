// Equity calculations.

/** Exact equity of hands/ranges on a given board by enumerating runouts. */
export function exactEquity(players, board = [], dead = []) {
  // TODO
}

/** Monte Carlo equity for multiway or preflop range vs range. */
export function monteCarloEquity(players, board = [], { iterations = 100000 } = {}) {
  // TODO
}

/** Fast preflop lookup using the precomputed 169x169 table. */
export function preflopEquity(classA, classB) {
  // TODO: load data/preflop-equity-169.json
}
