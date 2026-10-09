// Decision EV maths (chip EV).

/** Equity needed to call: call / (pot + call). */
export function requiredEquity(pot, toCall) {
  // TODO
}

/** EV of calling given equity. */
export function callEV({ pot, toCall, equity }) {
  // TODO
}

/** EV of a bet/jam: fold equity + equity when called. */
export function betEV({ pot, bet, foldFreq, equityWhenCalled }) {
  // TODO
}

/** Fold frequency a pure bluff needs to break even: bet / (pot + bet). */
export function breakEvenFoldFreq(pot, bet) {
  // TODO
}
