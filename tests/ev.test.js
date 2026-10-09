import { describe, it, expect } from 'vitest';
import {
  requiredEquity,
  callEV,
  betEV,
  breakEvenFoldFreq,
  mdf,
  jamEV,
  jamDetails,
  rakeAmount,
  effectiveStack,
} from '../src/calc/ev.js';

describe('ev', () => {
  it('computes required equity as toCall / (pot + toCall)', () => {
    expect(requiredEquity(100, 50)).toBeCloseTo(1 / 3, 12);
    expect(requiredEquity(150, 50)).toBe(0.25);
    expect(requiredEquity(100, 0)).toBe(0);
  });

  it('callEV is zero at exactly the required equity', () => {
    const pot = 150;
    const toCall = 70;
    const req = requiredEquity(pot, toCall);
    expect(callEV({ pot, toCall, equity: req })).toBeCloseTo(0, 10);
    expect(callEV({ pot, toCall, equity: req + 0.1 })).toBeGreaterThan(0);
    expect(callEV({ pot, toCall, equity: req - 0.1 })).toBeLessThan(0);
    expect(callEV({ pot: 150, toCall: 50, equity: 0.35 })).toBeCloseTo(20, 10);
  });

  it('computes break-even fold frequency and MDF', () => {
    expect(breakEvenFoldFreq(100, 50)).toBeCloseTo(1 / 3, 12);
    expect(mdf(100, 100)).toBe(0.5);
    expect(mdf(100, 50) + breakEvenFoldFreq(100, 50)).toBeCloseTo(1, 12);
  });

  it('betEV with foldFreq 1 wins the pot, and matches the formula otherwise', () => {
    expect(betEV({ pot: 120, bet: 80, foldFreq: 1, equityWhenCalled: 0.2 })).toBe(120);
    expect(betEV({ pot: 150, bet: 50, foldFreq: 0.4, equityWhenCalled: 0.35 })).toBeCloseTo(82.5, 10);
    // a pure bluff at the break-even fold frequency is worth 0
    const f = breakEvenFoldFreq(100, 75);
    expect(betEV({ pot: 100, bet: 75, foldFreq: f, equityWhenCalled: 0 })).toBeCloseTo(0, 10);
  });

  it('jamEV only risks the effective stack', () => {
    const args = { heroStack: 1000, villainStack: 300, pot: 100, foldFreq: 0.3, equityWhenCalled: 0.4 };
    expect(effectiveStack(1000, 300)).toBe(300);
    expect(jamDetails(args).risk).toBe(300);
    expect(jamEV(args)).toBeCloseTo(betEV({ pot: 100, bet: 300, foldFreq: 0.3, equityWhenCalled: 0.4 }), 10);
    // more chips behind for hero than villain can call changes nothing
    expect(jamEV({ ...args, heroStack: 50000 })).toBeCloseTo(jamEV(args), 10);
    // hero short: risks hero's stack
    expect(jamDetails({ ...args, heroStack: 200 }).risk).toBe(200);
  });

  it('jamEV over a bet counts villain bet as already in the pot', () => {
    // pot 250 includes villain's 100 bet; villain has 400 behind; hero jams 500 total
    const r = jamDetails({ heroStack: 1000, villainStack: 400, pot: 250, toCall: 100, foldFreq: 0, equityWhenCalled: 0.5 });
    expect(r.risk).toBe(500);
    expect(r.finalPot).toBe(250 + 500 + 400);
    expect(r.ev).toBeCloseTo(0.5 * 1150 - 500, 10);
    // jam that is not a raise: villain cannot fold
    const call = jamDetails({ heroStack: 80, villainStack: 400, pot: 250, toCall: 100, foldFreq: 0.9, equityWhenCalled: 0.5 });
    expect(call.ev).toBeCloseTo(0.5 * (250 - 20 + 80) - 80, 10);
  });

  it('applies rake with a cap to the final pot', () => {
    const rake = { percent: 5, cap: 3 };
    expect(rakeAmount(40, rake)).toBe(2);
    expect(rakeAmount(200, rake)).toBe(3);
    expect(requiredEquity(150, 50, { rake })).toBeCloseTo(50 / 197, 12);
    expect(callEV({ pot: 150, toCall: 50, equity: 0.5, rake })).toBeCloseTo(0.5 * 197 - 50, 12);
    expect(betEV({ pot: 20, bet: 10, foldFreq: 1, equityWhenCalled: 0, rake })).toBe(19);
    expect(requiredEquity(150, 50)).toBe(0.25);
  });

  it('skips rake on pots that end before the flop with no flop, no drop', () => {
    const rake = { percent: 5, cap: 3, noFlopNoDrop: true };
    // villain folds preflop: no rake
    expect(betEV({ pot: 15, bet: 50, foldFreq: 1, equityWhenCalled: 0, rake, preflop: true })).toBe(15);
    // the same pot on the flop is raked
    expect(betEV({ pot: 15, bet: 50, foldFreq: 1, equityWhenCalled: 0, rake, preflop: false })).toBe(14.25);
    // a called preflop all-in sees a flop, so it is raked
    const jam = jamDetails({ heroStack: 100, villainStack: 100, pot: 15, foldFreq: 0, equityWhenCalled: 1, rake, preflop: true });
    expect(jam.ev).toBeCloseTo(215 - 3 - 100, 10);
    expect(rakeAmount(100, rake, { flopSeen: false })).toBe(0);
    expect(breakEvenFoldFreq(15, 50, { rake, preflop: true })).toBeCloseTo(50 / 65, 12);
  });

  it('validates input', () => {
    expect(() => requiredEquity(-1, 10)).toThrow(/Pot/);
    expect(() => requiredEquity(0, 0)).toThrow(/zero/);
    expect(() => callEV({ pot: 100, toCall: 10, equity: 1.2 })).toThrow(/Equity/);
    expect(() => betEV({ pot: 100, bet: 10, foldFreq: -0.1, equityWhenCalled: 0.5 })).toThrow(/Fold frequency/);
    expect(() => jamEV({ heroStack: 0, villainStack: 10, pot: 5, foldFreq: 0, equityWhenCalled: 0.5 })).toThrow(/no chips/);
    expect(() => rakeAmount(100, { percent: 150 })).toThrow(/Rake percent/);
    expect(() => callEV({ pot: '100', toCall: 10, equity: 0.5 })).toThrow(/number/);
  });
});
