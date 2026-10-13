import { describe, it, expect } from 'vitest';
import { createHand, validateHand, legalActions, startState, applyAction, nextStreet, toBB, formatAmount, heroSeat, results } from '../src/review/hand.js';
import { chipsHand, act } from './helpers/make-hand.js';

const six = (actions = [], extra = {}) =>
  chipsHand({
    button: 6,
    players: [
      ['SBp', 10000],
      ['BBp', 10000],
      ['UTGp', 10000],
      ['HJp', 10000],
      ['COp', 10000],
      ['Hero', 10000, 'AhKd'],
    ],
    actions: [act('SBp', 'sb', 50), act('BBp', 'bb', 100), ...actions],
    ...extra,
  });

describe('createHand', () => {
  it('rejects hands it cannot use', () => {
    expect(() => createHand({ blinds: { bb: 100 }, button: 1, players: [{ seat: 1, name: 'A', stack: 100 }] })).toThrow(/two players/);
    expect(() => chipsHand({ players: [['A', 100], ['A', 100]] })).toThrow(/used twice/);
    expect(() => chipsHand({ players: [['A', 100], ['B', 100]], hero: 'C' })).toThrow(/not at the table/);
    expect(() => chipsHand({ players: [['A', 100], ['B', 100]], hero: 'A', actions: [{ street: 'preflop', player: 'A', type: 'shove' }] })).toThrow(/unknown type/);
    expect(() => chipsHand({ players: [['A', 100.5], ['B', 100]], hero: 'A' })).toThrow(/whole number/);
  });

  it('labels positions from the button, heads-up and full ring', () => {
    expect(six().players.map((p) => p.position)).toEqual(['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN']);
    const hu = chipsHand({ button: 2, players: [['Villain', 1000], ['Hero', 1000]], actions: [act('Hero', 'sb', 50), act('Villain', 'bb', 100)] });
    expect(hu.players.map((p) => p.position)).toEqual(['BB', 'SB']);
    const seven = chipsHand({
      button: 7,
      maxSeats: 9,
      players: ['a', 'b', 'c', 'd', 'e', 'f', 'Hero'].map((n) => [n, 1000]),
      actions: [act('a', 'sb', 50), act('b', 'bb', 100)],
    });
    expect(seven.players.map((p) => p.position)).toEqual(['SB', 'BB', 'MP', 'LJ', 'HJ', 'CO', 'BTN']);
  });

  it('fills amounts: calls, bets given by amount, raises by "to", and all-in', () => {
    const h = six([act('UTGp', 'raise', 300), act('HJp', 'fold'), act('COp', 'call'), { street: 'preflop', player: 'Hero', type: 'allin' }]);
    // actions[0] and [1] are the blind posts.
    expect(h.actions[2]).toMatchObject({ type: 'raise', amount: 300, to: 300, isAllIn: false });
    expect(h.actions[4]).toMatchObject({ type: 'call', amount: 300, to: 300 });
    expect(h.actions[5]).toMatchObject({ type: 'raise', amount: 10000, to: 10000, isAllIn: true });
  });

  it('converts for display', () => {
    const cash = createHand({ unit: { currency: '$', scale: 100 }, blinds: { sb: 10, bb: 25 }, button: 1, players: [{ seat: 1, name: 'A', stack: 2500 }, { seat: 2, name: 'B', stack: 2742 }], hero: 'B' });
    expect(formatAmount(25, cash)).toBe('$0.25');
    expect(formatAmount(2500, cash)).toBe('$25');
    expect(toBB(2742, cash)).toBeCloseTo(109.68, 10);
    expect(heroSeat(cash)).toBe(2);
    expect(formatAmount(12500, six())).toBe('12,500');
  });
});

describe('validateHand', () => {
  it('accepts a consistent hand', () => {
    const h = six([act('UTGp', 'fold'), act('HJp', 'fold'), act('COp', 'fold'), act('Hero', 'raise', 250), act('SBp', 'fold'), act('BBp', 'fold')], {
      uncalled: [{ player: 'Hero', amount: 150 }],
      collected: [{ player: 'Hero', amount: 250 }],
      pot: 250,
    });
    expect(validateHand(h)).toEqual([]);
    expect(results(h).get('Hero').net).toBe(150);
  });

  it('finds a card dealt twice', () => {
    const h = six([], { board: 'AhQs2c' });
    expect(validateHand(h).map((p) => p.code)).toContain('cards');
  });

  it('finds chips that do not add up', () => {
    const h = six([act('UTGp', 'fold'), act('HJp', 'fold'), act('COp', 'fold'), act('Hero', 'fold'), act('SBp', 'fold')], {
      uncalled: [{ player: 'BBp', amount: 50 }],
      collected: [{ player: 'BBp', amount: 120 }],
      pot: 100,
    });
    const messages = validateHand(h).map((p) => p.message);
    expect(messages.some((m) => /collected 120/.test(m))).toBe(true);
  });

  it('finds actions out of turn and illegal checks and raises', () => {
    const outOfTurn = six([act('HJp', 'fold')]);
    expect(validateHand(outOfTurn).some((p) => /out of turn/.test(p.message))).toBe(true);
    const badCheck = six([act('UTGp', 'check')]);
    expect(validateHand(badCheck).some((p) => /checks facing a bet/.test(p.message))).toBe(true);
    const smallRaise = six([act('UTGp', 'raise', 150)]);
    expect(validateHand(smallRaise).some((p) => /less than the minimum/.test(p.message))).toBe(true);
  });
});

describe('legalActions', () => {
  const walk = (hand) => hand.actions.reduce((s, a) => applyAction(s, a, hand).state, startState(hand));

  it('offers fold / call / raise preflop with the minimum raise', () => {
    const h = six();
    const legal = legalActions(walk(h), h);
    expect(legal).toMatchObject({ player: 'UTGp', toCall: 100, options: ['fold', 'call', 'raise'], minTo: 200, maxTo: 10000 });
  });

  it('gives the big blind the option after limps', () => {
    const h = six([act('UTGp', 'call'), act('HJp', 'fold'), act('COp', 'fold'), act('Hero', 'fold'), act('SBp', 'call')]);
    expect(legalActions(walk(h), h)).toMatchObject({ player: 'BBp', options: ['check', 'raise'] });
  });

  it('starts the flop left of the button with check or bet', () => {
    const h = six([act('UTGp', 'call'), act('HJp', 'fold'), act('COp', 'fold'), act('Hero', 'fold'), act('SBp', 'call'), act('BBp', 'check')]);
    const flop = nextStreet(walk(h), 'flop', h);
    expect(legalActions(flop, h)).toMatchObject({ player: 'SBp', options: ['check', 'bet'], minTo: 100 });
  });

  it('stops the betting when everyone else is all-in', () => {
    const h = six([act('UTGp', 'fold'), act('HJp', 'fold'), act('COp', 'fold'), { street: 'preflop', player: 'Hero', type: 'allin' }, act('SBp', 'fold'), act('BBp', 'call')]);
    expect(legalActions(walk(h), h)).toBeNull();
  });
});
