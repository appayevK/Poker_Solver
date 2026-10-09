// Decision EV maths (chip EV).
//
// Conventions:
// - `pot` is everything already in the middle, including villain's bet.
// - EVs are measured relative to folding now (fold = 0), in the same unit as the
//   inputs (chips or big blinds).
// - Optional rake: functions that pay out a pot accept `rake: { percent, cap,
//   noFlopNoDrop }`, applied to the final pot. `percent` is a percentage (5 = 5%),
//   `cap` is in chips (default: no cap). Default is no rake.
// - No flop, no drop (GG cash and most online cash games): pots that end before a
//   flop is dealt are not raked. With `noFlopNoDrop: true`, pass `preflop: true` for
//   a preflop spot and the uncontested (villain folds) branch goes unraked. A called
//   preflop all-in still deals a flop, so that pot is raked.

function checkNumber(name, value, min = 0, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number (got ${value})`);
  }
  if (value < min || value > max) {
    throw new Error(
      max === Infinity ? `${name} must be at least ${min} (got ${value})` : `${name} must be between ${min} and ${max} (got ${value})`,
    );
  }
  return value;
}

const checkProbability = (name, value) => checkNumber(name, value, 0, 1);

/**
 * Rake taken from a final pot. rake = { percent, cap = Infinity, noFlopNoDrop = false }.
 * flopSeen = false with noFlopNoDrop means no rake.
 */
export function rakeAmount(finalPot, rake, { flopSeen = true } = {}) {
  checkNumber('Pot', finalPot);
  if (!rake) return 0;
  const { percent = 0, cap = Infinity, noFlopNoDrop = false } = rake;
  checkNumber('Rake percent', percent, 0, 100);
  if (cap !== Infinity) checkNumber('Rake cap', cap);
  if (noFlopNoDrop && !flopSeen) return 0;
  return Math.min((finalPot * percent) / 100, cap);
}

/** What the winner collects from a final pot after rake. */
function netPot(finalPot, rake, flopSeen = true) {
  return finalPot - rakeAmount(finalPot, rake, { flopSeen });
}

/** Equity needed to call: toCall / (pot + toCall), with the final pot net of rake. */
export function requiredEquity(pot, toCall, { rake } = {}) {
  checkNumber('Pot', pot);
  checkNumber('To call', toCall);
  if (pot + toCall === 0) throw new Error('Pot and call cannot both be zero');
  const win = netPot(pot + toCall, rake);
  if (win <= 0) throw new Error('Rake takes the whole pot');
  return toCall / win;
}

/** EV of calling given equity: equity * (pot + toCall) - toCall (relative to folding). */
export function callEV({ pot, toCall, equity, rake }) {
  checkNumber('Pot', pot);
  checkNumber('To call', toCall);
  checkProbability('Equity', equity);
  return equity * netPot(pot + toCall, rake) - toCall;
}

/**
 * EV of a bet: fold equity + equity when called.
 *   foldFreq * pot + (1 - foldFreq) * (equityWhenCalled * (pot + 2 * bet) - bet)
 * Assumes villain only folds or calls (no raises) and that a called pot is played
 * out at `equityWhenCalled`.
 */
export function betEV({ pot, bet, foldFreq, equityWhenCalled, rake, preflop = false }) {
  checkNumber('Pot', pot);
  checkNumber('Bet', bet);
  checkProbability('Fold frequency', foldFreq);
  checkProbability('Equity when called', equityWhenCalled);
  const foldWin = netPot(pot, rake, !preflop);
  const calledWin = netPot(pot + 2 * bet, rake);
  return foldFreq * foldWin + (1 - foldFreq) * (equityWhenCalled * calledWin - bet);
}

/** Fold frequency a pure bluff needs to break even: bet / (pot + bet). */
export function breakEvenFoldFreq(pot, bet, { rake, preflop = false } = {}) {
  checkNumber('Pot', pot);
  checkNumber('Bet', bet);
  if (pot + bet === 0) throw new Error('Pot and bet cannot both be zero');
  return bet / (netPot(pot, rake, !preflop) + bet);
}

/** Minimum defence frequency against a bet: pot / (pot + bet), pot before the bet. */
export function mdf(pot, bet) {
  checkNumber('Pot', pot);
  checkNumber('Bet', bet);
  if (pot + bet === 0) throw new Error('Pot and bet cannot both be zero');
  return pot / (pot + bet);
}

/** Effective stack: the most either player can lose to the other. */
export function effectiveStack(heroStack, villainStack) {
  checkNumber('Hero stack', heroStack);
  checkNumber('Villain stack', villainStack);
  return Math.min(heroStack, villainStack);
}

/**
 * EV of jamming. Stacks are chips behind (not counting chips already in the pot).
 * The jam only risks what villain can call: hero puts in
 *   risk = min(heroStack, toCall + villainStack)
 * where toCall (default 0) is villain's outstanding bet, already part of `pot`.
 * If the jam is not a raise (risk <= toCall) villain cannot fold, so foldFreq is ignored.
 * Returns { ev, risk, finalPot }.
 */
export function jamDetails({ heroStack, villainStack, pot, foldFreq, equityWhenCalled, toCall = 0, rake, preflop = false }) {
  checkNumber('Hero stack', heroStack);
  checkNumber('Villain stack', villainStack);
  checkNumber('Pot', pot);
  checkNumber('To call', toCall);
  checkProbability('Fold frequency', foldFreq);
  checkProbability('Equity when called', equityWhenCalled);
  if (heroStack === 0) throw new Error('Hero has no chips to jam');
  const risk = Math.min(heroStack, toCall + villainStack);
  const f = risk > toCall ? foldFreq : 0;
  const finalPot = pot + 2 * risk - toCall;
  const ev = f * netPot(pot, rake, !preflop) + (1 - f) * (equityWhenCalled * netPot(finalPot, rake) - risk);
  return { ev, risk, finalPot };
}

/** EV of jamming relative to folding; see jamDetails for the model. */
export function jamEV(args) {
  return jamDetails(args).ev;
}
