import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGGFile } from '../src/review/gg-parser.js';
import { buildStates, analyseDecision, sidePots, postedState, pushFoldSpot } from '../src/review/replayer.js';
import { requiredEquity, callEV } from '../src/calc/ev.js';
import { chipsHand, act } from './helpers/make-hand.js';

const cash = parseGGFile(readFileSync('tests/fixtures/hand-histories/cash-nl25-01.txt', 'utf8')).hands.map((x) => x.hand);
const fixedEquity = (equity) => async () => ({ players: [{ equity }] });

describe('buildStates', () => {
  it('matches a hand-worked pot and stacks after every action (HD3083050899)', () => {
    const hand = cash.find((h) => h.id === 'HD3083050899');
    expect(postedState(hand).pot).toBe(35);
    const states = buildStates(hand);
    const stack = (s, name) => s.table.find((p) => p.name === name).stack;
    // [actor, action, pot after, hero stack after, BB (b48f0e7e) stack after], in cents.
    const worked = [
      ['5f4dad3f', 'fold', 35, 2614, 744],
      ['Hero', 'raise', 98, 2551, 744],
      ['c4e5faf1', 'fold', 98, 2551, 744],
      ['ddfecbb0', 'fold', 98, 2551, 744],
      ['b48f0e7e', 'call', 136, 2551, 706],
      ['b48f0e7e', 'check', 136, 2551, 706],
      ['Hero', 'bet', 204, 2483, 706],
      ['b48f0e7e', 'call', 272, 2483, 638],
      ['b48f0e7e', 'check', 272, 2483, 638],
      ['Hero', 'bet', 408, 2347, 638],
      ['b48f0e7e', 'fold', 408, 2347, 638],
    ];
    expect(states.map((s) => [s.actor, s.action.type, s.potAfter, stack(s, 'Hero'), stack(s, 'b48f0e7e')])).toEqual(worked);
    // Before hero's flop bet: pot 1.36, nothing to call, effective stack = BB's 7.06.
    expect(states[6]).toMatchObject({ street: 'flop', pot: 136, toCall: 0, effectiveStack: 706, isHero: true });
    expect(states[6].board).toHaveLength(3);
    // Before the BB's preflop call: 0.38 to call into 0.98.
    expect(states[4]).toMatchObject({ toCall: 38, callAmount: 38, facing: { player: 'Hero', potBefore: 35, bet: 63, to: 63 } });
    expect(states[4].potOdds).toBeCloseTo(38 / 136, 12);
  });

  it('splits side pots in a 3-way all-in with different stacks', () => {
    const hand = chipsHand({
      button: 1,
      players: [
        ['Big', 1000],
        ['Mid', 500],
        ['Hero', 200, 'AhKd'],
      ],
      actions: [act('Mid', 'sb', 50), act('Hero', 'bb', 100), { street: 'preflop', player: 'Big', type: 'allin' }, act('Mid', 'call'), act('Hero', 'call')],
    });
    const last = buildStates(hand).at(-1);
    expect(last.pots).toEqual([
      { amount: 600, eligible: ['Mid', 'Hero', 'Big'] },
      { amount: 600, eligible: ['Mid', 'Big'] },
      { amount: 500, eligible: ['Big'] },
    ]);
    expect(sidePots([{ name: 'A', total: 100, folded: true, allIn: false }, { name: 'B', total: 300, folded: false, allIn: false }, { name: 'C', total: 300, folded: false, allIn: true }])).toEqual([
      { amount: 700, eligible: ['B', 'C'] },
    ]);
  });
});

describe('analyseDecision', () => {
  // Heads-up to the river: villain bets 500 into 1000, hero to call.
  const river = chipsHand({
    button: 2,
    players: [
      ['Villain', 10000],
      ['Hero', 10000, 'AsJd'],
    ],
    board: 'Ah7c4d9s2h',
    actions: [
      act('Hero', 'sb', 50),
      act('Villain', 'bb', 100),
      act('Hero', 'raise', 300),
      act('Villain', 'call'),
      act('Villain', 'check', null, 'flop'),
      act('Hero', 'bet', 200, 'flop'),
      act('Villain', 'call', null, 'flop'),
      act('Villain', 'check', null, 'turn'),
      act('Hero', 'check', null, 'turn'),
      act('Villain', 'bet', 500, 'river'),
      act('Hero', 'call', null, 'river'),
    ],
  });

  it('matches calc/ev.js for a river call', async () => {
    const s = buildStates(river).at(-1);
    expect(s).toMatchObject({ pot: 1500, callAmount: 500, isHero: true });
    const an = await analyseDecision(s, { hand: river, villainRange: 'AK,AQ,77,44', equityFn: fixedEquity(0.3) });
    expect(an.kind).toBe('facingBet');
    expect(an.villain).toBe('Villain');
    expect(an.requiredEquity).toBeCloseTo(requiredEquity(1500, 500), 12);
    expect(an.requiredEquity).toBeCloseTo(0.25, 12);
    expect(an.callEV).toBeCloseTo(callEV({ pot: 1500, toCall: 500, equity: 0.3 }) / 100, 12);
    expect(an.mdf).toBeCloseTo(1000 / 1500, 12);
  });

  it('works out equity with the real engine when no backend is given', async () => {
    const s = buildStates(river).at(-1);
    const an = await analyseDecision(s, { hand: river, villainRange: 'KK' });
    expect(an.equity).toBe(1); // AJ has top pair against KK on this board
  });

  it('treats a preflop open as an open, not a call decision', async () => {
    const hand = cash.find((h) => h.id === 'HD3083050899');
    const s = buildStates(hand).find((x) => x.isHero);
    const an = await analyseDecision(s, { hand, equityFn: fixedEquity(0.5) });
    expect(an.kind).toBe('open');
    expect(an.villain).toBeNull();
    expect(an.requiredEquity).toBeNull();
    expect(an.breakEvenFoldFreq).toBeCloseTo(63 / (35 + 63), 12);
  });

  // Folded to hero on the button with 10 bb each.
  const tenBB = (heroCards, heroAction) =>
    chipsHand({
      button: 6,
      players: [
        ['SBp', 1000],
        ['BBp', 1000],
        ['UTGp', 1000],
        ['HJp', 1000],
        ['COp', 1000],
        ['Hero', 1000, heroCards],
      ],
      actions: [act('SBp', 'sb', 50), act('BBp', 'bb', 100), act('UTGp', 'fold'), act('HJp', 'fold'), act('COp', 'fold'), heroAction],
    });

  it('returns the Nash action in a 10 bb folded-to-hero spot', async () => {
    const hand = tenBB('AhKd', { street: 'preflop', player: 'Hero', type: 'allin' });
    const s = buildStates(hand).find((x) => x.isHero);
    expect(pushFoldSpot(hand, s)).toEqual({ open: true, jammer: null, seats: ['Hero', 'SBp', 'BBp'] });
    const an = await analyseDecision(s, { hand, equityFn: fixedEquity(0.5) });
    expect(an.nash).toMatchObject({ action: 'jam', heroAction: 'jam', mode: 'chipEV', open: true, evLoss: 0, unit: 'bb' });
    expect(an.nash.evGap).toBeGreaterThan(0);
  });

  it('measures what folding a Nash jam gives up', async () => {
    const hand = tenBB('AhAd', act('Hero', 'fold'));
    const an = await analyseDecision(buildStates(hand).find((x) => x.isHero), { hand, equityFn: fixedEquity(0.5) });
    expect(an.nash.heroAction).toBe('fold');
    expect(an.nash.evLoss).toBeGreaterThan(1);
  });
});
