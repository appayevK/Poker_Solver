// Independent Chip Model (Malmuth-Harville), memoised over remaining-player subsets.

/** $EV for each player given stacks and payouts. */
export function icmEquity(stacks, payouts) {
  // TODO
}

/** $EV of a jam/call decision: weighted over outcomes (fold / call-win / call-lose). */
export function icmDecisionEV({ stacks, payouts, hero, villain, risk, outcomes }) {
  // TODO
}

/** Extra equity required under ICM vs chip EV for a given call. */
export function riskPremium({ stacks, payouts, hero, villain }) {
  // TODO
}
