import { describe, it, expect } from 'vitest';
import {
  bountyChipValue,
  bountyDollarValue,
  dollarsPerChip,
  startingDollarsPerChip,
  pkoRequiredEquity,
  pkoCallEV,
} from '../src/calc/pko.js';
import { requiredEquity, callEV } from '../src/calc/ev.js';

describe('pko', () => {
  it('a starting bounty is worth half a starting stack by default', () => {
    expect(bountyChipValue({ bounty: 10, startingBounty: 10, startingStack: 20000 })).toBe(10000);
    expect(bountyChipValue({ bounty: 25, startingBounty: 25, startingStack: 10000 })).toBe(5000);
  });

  it('counts part of the head half with headValueFactor', () => {
    const base = { bounty: 10, startingBounty: 10, startingStack: 20000 };
    expect(bountyChipValue({ ...base, headValueFactor: 1 })).toBe(20000);
    expect(bountyChipValue({ ...base, headValueFactor: 0.5 })).toBe(15000);
    expect(bountyDollarValue({ bounty: 10, headValueFactor: 0.5 })).toBe(7.5);
  });

  it('converts at an explicit $/chip rate', () => {
    const rate = dollarsPerChip({ prizePool: 5000, chipsInPlay: 1_000_000 });
    expect(rate).toBe(0.005);
    expect(startingDollarsPerChip({ startingBounty: 5, startingStack: 1000 })).toBe(0.005);
    expect(bountyChipValue({ bounty: 40, rate })).toBe(4000);
  });

  it('required equity falls when a bounty is added', () => {
    const pot = 3000;
    const toCall = 2500;
    const without = pkoRequiredEquity({ pot, toCall, bountyChips: 0 });
    expect(without).toBeCloseTo(requiredEquity(pot, toCall), 12);
    const withBounty = pkoRequiredEquity({ pot, toCall, bountyChips: 5000 });
    expect(withBounty).toBeLessThan(without);
    expect(withBounty).toBeCloseTo(2500 / 10500, 12);
  });

  it('a bounty is worth nothing when villain covers hero', () => {
    const args = { pot: 3000, toCall: 2500, bountyChips: 5000 };
    expect(pkoRequiredEquity({ ...args, heroCovers: false })).toBeCloseTo(requiredEquity(3000, 2500), 12);
    const ev = pkoCallEV({ ...args, equity: 0.4, heroCovers: false });
    expect(ev).toBeCloseTo(callEV({ pot: 3000, toCall: 2500, equity: 0.4 }), 10);
    expect(pkoCallEV({ ...args, equity: 0.4, heroCovers: true })).toBeCloseTo(ev + 0.4 * 5000, 10);
    // split pots bust nobody
    expect(pkoCallEV({ ...args, equity: 0.4, winProbability: 0.35, heroCovers: true })).toBeCloseTo(ev + 0.35 * 5000, 10);
  });

  it('validates input', () => {
    expect(() => bountyChipValue({ bounty: -1, startingBounty: 10, startingStack: 1000 })).toThrow(/Bounty/);
    expect(() => bountyChipValue({ bounty: 10, startingBounty: 0, startingStack: 1000 })).toThrow(/Starting bounty/);
    expect(() => bountyChipValue({ bounty: 10, startingBounty: 10, startingStack: 1000, headValueFactor: 2 })).toThrow(/Head-value/);
    expect(() => dollarsPerChip({ prizePool: 100, chipsInPlay: 0 })).toThrow(/Chips in play/);
    expect(() => pkoCallEV({ pot: 10, toCall: 5, equity: 0.5, bountyChips: 10 })).toThrow(/heroCovers/);
  });
});
