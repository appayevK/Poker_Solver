import { describe, it, expect } from 'vitest';
import { handFromForm } from '../src/review/manual-entry.js';
import { createHand, validateHand, results } from '../src/review/hand.js';

// A live $1/$2 hand: hero on the button raises, the big blind calls, hero bets the flop
// and the big blind folds.
const form = {
  id: 'live-1',
  date: '2026-10-12T21:00:00',
  format: 'cash',
  blinds: { sb: 1, bb: 2, ante: 0 },
  button: 3,
  maxSeats: 6,
  players: [
    { seat: 1, name: 'Mike', stack: 200 },
    { seat: 2, name: 'Ana', stack: 350 },
    { seat: 3, name: 'Hero', stack: 300 },
  ],
  hero: 'Hero',
  heroCards: 'AsQs',
  actions: [
    { street: 'preflop', player: 'Hero', type: 'raise', to: 6 },
    { street: 'preflop', player: 'Mike', type: 'fold' },
    { street: 'preflop', player: 'Ana', type: 'call' },
    { street: 'flop', player: 'Ana', type: 'check' },
    { street: 'flop', player: 'Hero', type: 'bet', to: 8 },
    { street: 'flop', player: 'Ana', type: 'fold' },
  ],
  board: 'Qd7c2h',
  winners: ['Hero'],
};

describe('manual entry', () => {
  it('builds the same hand as building it directly', () => {
    const direct = createHand({
      id: 'live-1',
      site: 'manual',
      format: 'cash',
      date: '2026-10-12T21:00:00',
      table: 'Live',
      maxSeats: 6,
      button: 3,
      unit: { currency: '$', scale: 100 },
      blinds: { sb: 100, bb: 200, ante: 0, bbAnte: false },
      players: [
        { seat: 1, name: 'Mike', stack: 20000 },
        { seat: 2, name: 'Ana', stack: 35000 },
        { seat: 3, name: 'Hero', stack: 30000, cards: 'AsQs' },
      ],
      hero: 'Hero',
      actions: [
        { street: 'preflop', player: 'Mike', type: 'post', post: 'sb', amount: 100 },
        { street: 'preflop', player: 'Ana', type: 'post', post: 'bb', amount: 200 },
        { street: 'preflop', player: 'Hero', type: 'raise', to: 600 },
        { street: 'preflop', player: 'Mike', type: 'fold' },
        { street: 'preflop', player: 'Ana', type: 'call' },
        { street: 'flop', player: 'Ana', type: 'check' },
        { street: 'flop', player: 'Hero', type: 'bet', amount: 800 },
        { street: 'flop', player: 'Ana', type: 'fold' },
      ],
      board: 'Qd7c2h',
      uncalled: [{ player: 'Hero', amount: 800 }],
      collected: [{ player: 'Hero', amount: 1300 }],
      pot: 1300,
    });
    expect(handFromForm(form)).toEqual(direct);
  });

  it('gives a valid hand with the right result', () => {
    const hand = handFromForm(form);
    expect(validateHand(hand)).toEqual([]);
    expect(hand.players.map((p) => p.position)).toEqual(['SB', 'BB', 'BTN']);
    expect(results(hand).get('Hero').net).toBe(700);
  });

  it('posts antes, handles an all-in and splits a pot', () => {
    const hand = handFromForm({
      format: 'mtt',
      blinds: { sb: 100, bb: 200, ante: 200, bbAnte: true },
      button: 2,
      players: [
        { seat: 1, name: 'Hero', stack: 3000 },
        { seat: 2, name: 'Villain', stack: 5000 },
      ],
      hero: 'Hero',
      heroCards: 'KdKc',
      actions: [
        { street: 'preflop', player: 'Villain', type: 'allin' },
        { street: 'preflop', player: 'Hero', type: 'call' },
      ],
      board: 'Ah7c2d9s3h',
      winners: ['Hero', 'Villain'],
    });
    expect(hand.actions.slice(0, 3).map((a) => [a.player, a.post, a.amount])).toEqual([
      ['Hero', 'ante', 200],
      ['Villain', 'sb', 100],
      ['Hero', 'bb', 200],
    ]);
    expect(hand.uncalled).toEqual([{ player: 'Villain', amount: 2000 }]);
    expect(hand.collected).toEqual([
      { player: 'Hero', amount: 3000 },
      { player: 'Villain', amount: 3000 },
    ]);
    expect(validateHand(hand)).toEqual([]);
  });
});
