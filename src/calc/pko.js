// Progressive knockout bounty maths (GGPoker style: 50% paid now, 50% added to own head).
//
// Model: when you bust a player, half of their bounty is paid to you in cash at once
// and the other half is added to your own bounty. You only win a bounty when you
// cover the player (have at least as many chips), so they bust when they lose.
//
// To compare bounty dollars with chips, convert at a $/chip rate. Early on, with a
// 50/50 buy-in split, the prize-pool part of each buy-in equals the starting bounty,
// so $/chip = startingBounty / startingStack and a starting bounty's cash half is worth
// startingStack / 2 chips.
//
// headValueFactor (0..1) is how much of the half added to your own head you count as
// value now. That half is not cash: it is paid to whoever busts you, and you only
// collect it by winning the tournament. Its present value is small early, so the
// default is 0. Some players count part of it (around 0.3-0.5) deep in the event.

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

function checkPositive(name, value) {
  checkNumber(name, value);
  if (value === 0) throw new Error(`${name} must be greater than 0`);
  return value;
}

/** $ value of one chip: prize pool (excluding bounties) / chips in play. */
export function dollarsPerChip({ prizePool, chipsInPlay }) {
  checkPositive('Prize pool', prizePool);
  checkPositive('Chips in play', chipsInPlay);
  return prizePool / chipsInPlay;
}

/** Early-game shortcut with a 50/50 buy-in split: startingBounty / startingStack. */
export function startingDollarsPerChip({ startingBounty, startingStack }) {
  checkPositive('Starting bounty', startingBounty);
  checkPositive('Starting stack', startingStack);
  return startingBounty / startingStack;
}

/**
 * Chip value of winning a bounty:
 *   (bounty / 2 + headValueFactor * bounty / 2) / dollarsPerChip
 * Uses `rate` ($/chip) when given, otherwise startingBounty / startingStack.
 */
export function bountyChipValue({ bounty, startingBounty, startingStack, headValueFactor = 0, rate }) {
  checkNumber('Bounty', bounty);
  checkNumber('Head-value factor', headValueFactor, 0, 1);
  const perChip = rate !== undefined && rate !== null ? checkPositive('$/chip rate', rate) : startingDollarsPerChip({ startingBounty, startingStack });
  return (bounty / 2 + (headValueFactor * bounty) / 2) / perChip;
}

/** Cash a bust is worth in $ now: bounty / 2 plus the counted share of the head half. */
export function bountyDollarValue({ bounty, headValueFactor = 0 }) {
  checkNumber('Bounty', bounty);
  checkNumber('Head-value factor', headValueFactor, 0, 1);
  return (bounty / 2) * (1 + headValueFactor);
}

/**
 * Required equity to call once the bounty is factored in:
 *   toCall / (pot + toCall + bountyChips)
 * The bounty only counts when hero covers villain (heroCovers, default true).
 */
export function pkoRequiredEquity({ pot, toCall, bountyChips, heroCovers = true }) {
  checkNumber('Pot', pot);
  checkNumber('To call', toCall);
  checkNumber('Bounty chips', bountyChips);
  const total = pot + toCall + (heroCovers ? bountyChips : 0);
  if (total === 0) throw new Error('Pot and call cannot both be zero');
  return toCall / total;
}

/**
 * EV of calling a shove in chips, relative to folding:
 *   equity * (pot + toCall) - toCall, plus winProbability * bountyChips when hero covers.
 * When villain covers hero, winning does not bust villain and the bounty is worth nothing.
 * winProbability defaults to equity; pass the outright win chance to exclude split pots,
 * which bust nobody.
 */
export function pkoCallEV({ pot, toCall, equity, bountyChips, heroCovers, winProbability = equity }) {
  checkNumber('Pot', pot);
  checkNumber('To call', toCall);
  checkNumber('Equity', equity, 0, 1);
  checkNumber('Bounty chips', bountyChips);
  checkNumber('Win probability', winProbability, 0, 1);
  if (typeof heroCovers !== 'boolean') throw new Error('heroCovers must be true or false');
  return equity * (pot + toCall) - toCall + (heroCovers ? winProbability * bountyChips : 0);
}
