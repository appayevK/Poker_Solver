// Builds small hands for tests: chips (no currency), seats 1..n in the order given.
import { createHand } from '../../src/review/hand.js';

/** act('Hero', 'raise', 300) → a preflop action; bets take the amount, raises the "to". */
export function act(player, type, x, street = 'preflop') {
  if (type === 'bet') return { street, player, type, amount: x };
  if (type === 'raise') return { street, player, type, to: x };
  if (type === 'sb' || type === 'bb' || type === 'ante') return { street, player, type: 'post', post: type, amount: x };
  return { street, player, type };
}

/** players: [[name, stack, cards?], ...]; other fields go to createHand. */
export function chipsHand({ players, button = 1, blinds = { sb: 50, bb: 100 }, hero = 'Hero', ...rest }) {
  return createHand({
    id: 'T1',
    format: 'cash',
    unit: { currency: null, scale: 1 },
    blinds,
    button,
    hero,
    players: players.map(([name, stack, cards], i) => ({ seat: i + 1, name, stack, cards })),
    ...rest,
  });
}
