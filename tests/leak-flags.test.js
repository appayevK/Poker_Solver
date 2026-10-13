import { describe, it, expect } from 'vitest';
import { buildStates } from '../src/review/replayer.js';
import { detectLeaks, oversizedJams, LEAK_DEFAULTS } from '../src/review/leak-flags.js';
import { chipsHand, act } from './helpers/make-hand.js';

// A short stack (8 bb) jams UTG; hero on the button has 100 bb with both blinds behind.
const shortJam = (heroAction) => {
  const hand = chipsHand({
    button: 4,
    players: [
      ['SBp', 10000],
      ['BBp', 10000],
      ['Short', 800],
      ['Hero', 10000, 'AhQd'],
    ],
    actions: [act('SBp', 'sb', 50), act('BBp', 'bb', 100), { street: 'preflop', player: 'Short', type: 'allin' }, heroAction],
  });
  return { hand, states: buildStates(hand) };
};

const analysis = (fields) => ({
  actionIndex: 5,
  street: 'preflop',
  kind: 'facingBet',
  heroAction: 'call',
  villain: 'V',
  equity: 0.3,
  requiredEquity: 0.3,
  callEV: 0,
  icm: null,
  nash: null,
  rangeSource: 'default',
  ...fields,
});
const cashHand = shortJam(act('Hero', 'fold')).hand;

describe('oversized jams', () => {
  it('flags a 100 bb jam over an 8 bb all-in with players behind', () => {
    const { hand, states } = shortJam({ street: 'preflop', player: 'Hero', type: 'allin' });
    const flags = oversizedJams(hand, states);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ type: 'oversizedJam', street: 'preflop', actionIndex: 3, severity: 'high' });
    expect(flags[0].message).toMatch(/100 bb/);
    expect(flags[0].message).toMatch(/8 bb/);
  });

  it('does not flag a normal isolation raise, and the ratio is a parameter', () => {
    const iso = shortJam(act('Hero', 'raise', 2000));
    expect(oversizedJams(iso.hand, iso.states)).toEqual([]);
    const jam = shortJam({ street: 'preflop', player: 'Hero', type: 'allin' });
    expect(oversizedJams(jam.hand, jam.states, 20)).toEqual([]);
  });

  it('does not flag a jam when nobody is left behind', () => {
    const hand = chipsHand({
      button: 2,
      players: [
        ['Short', 800],
        ['Hero', 10000, 'AhQd'],
      ],
      actions: [act('Hero', 'sb', 50), act('Short', 'bb', 100), act('Hero', 'raise', 300), { street: 'preflop', player: 'Short', type: 'allin' }, { street: 'preflop', player: 'Hero', type: 'allin' }],
    });
    expect(oversizedJams(hand, buildStates(hand))).toEqual([]);
  });
});

describe('equity flags', () => {
  it('flags a call 5 points below the required equity, not 1 point', () => {
    const below = detectLeaks(cashHand, [], [analysis({ equity: 0.25, requiredEquity: 0.3, callEV: -0.5 })]);
    expect(below).toHaveLength(1);
    expect(below[0]).toMatchObject({ type: 'callBelowRequired', severity: 'medium' });
    expect(below[0].message).toMatch(/30\.0%/);
    expect(detectLeaks(cashHand, [], [analysis({ equity: 0.29, requiredEquity: 0.3 })])).toEqual([]);
    expect(detectLeaks(cashHand, [], [analysis({ equity: 0.25, requiredEquity: 0.3 })], { callMargin: 0.06 })).toEqual([]);
  });

  it('marks postflop flags on a default range as low severity and says so', () => {
    const [flag] = detectLeaks(cashHand, [], [analysis({ street: 'river', equity: 0.1, requiredEquity: 0.3 })]);
    expect(flag.severity).toBe('low');
    expect(flag.message).toMatch(/default range/);
    const [edited] = detectLeaks(cashHand, [], [analysis({ street: 'river', equity: 0.1, requiredEquity: 0.3, rangeSource: 'user' })]);
    expect(edited.severity).toBe('high');
  });

  it('uses the ICM required equity in tournaments', () => {
    const mtt = { ...cashHand, format: 'mtt' };
    const an = analysis({ equity: 0.35, requiredEquity: 0.33, icm: { requiredEquity: 0.42 } });
    expect(detectLeaks(cashHand, [], [an])).toEqual([]);
    const [flag] = detectLeaks(mtt, [], [an]);
    expect(flag.type).toBe('callBelowRequired');
    expect(flag.message).toMatch(/ICM/);
  });

  it('flags folding a clearly profitable call', () => {
    const [flag] = detectLeaks(cashHand, [], [analysis({ heroAction: 'fold', equity: 0.45, requiredEquity: 0.3, callEV: 3 })]);
    expect(flag.type).toBe('foldedProfitable');
    expect(detectLeaks(cashHand, [], [analysis({ heroAction: 'fold', equity: 0.32, requiredEquity: 0.3, callEV: 0.4 })])).toEqual([]);
  });

  it('flags a push/fold deviation above 0.3 bb', () => {
    const nash = (evLoss) => analysis({ kind: 'open', heroAction: 'fold', equity: null, requiredEquity: null, nash: { action: 'jam', frequency: 1, evGap: evLoss, unit: 'bb', mode: 'chipEV', heroAction: 'fold', evLoss, open: true } });
    const [flag] = detectLeaks(cashHand, [], [nash(1.2)]);
    expect(flag).toMatchObject({ type: 'nashDeviation', severity: 'high' });
    expect(detectLeaks(cashHand, [], [nash(0.2)])).toEqual([]);
    expect(LEAK_DEFAULTS.nashLossBB).toBe(0.3);
  });
});
