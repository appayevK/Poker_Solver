import { describe, it, expect } from 'vitest';
import {
  icmEquity,
  finishProbabilities,
  payoutsFromPercent,
  spotEV,
  icmRequiredEquity,
  chipRequiredEquity,
  riskPremium,
  icmDecisionEV,
} from '../src/calc/icm.js';

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// 4 left, 3 paid; seat 0 (SB) jams into seat 1 (BB); seat 1 decides.
const bubble = {
  stacks: [3000, 3000, 3000, 3000],
  payouts: [50, 30, 20],
  blinds: { sb: 100, bb: 200, ante: 25 },
  sbSeat: 0,
  bbSeat: 1,
  hero: 1,
  villain: 0,
  action: 'call',
};

describe('icm', () => {
  it('equal stacks give equal $EV', () => {
    const ev = icmEquity([1000, 1000, 1000, 1000], [50, 30, 20]);
    for (const x of ev) expect(x).toBeCloseTo(25, 10);
  });

  it('$EV sums to the payouts paid', () => {
    const payouts = [500, 300, 200];
    expect(sum(icmEquity([7000, 2000, 1000], payouts))).toBeCloseTo(1000, 9);
    expect(sum(icmEquity([7000, 2000, 1000, 500, 300], payouts))).toBeCloseTo(1000, 9);
    // more payouts than players left: only the top places are still in play
    expect(sum(icmEquity([7000, 2000], payouts))).toBeCloseTo(800, 9);
  });

  it('a player with all the chips gets 1st prize', () => {
    expect(icmEquity([10000, 0, 0], [50, 30, 20])).toEqual([50, 0, 0]);
  });

  it('players with 0 chips are out and get nothing', () => {
    const ev = icmEquity([5000, 0, 3000, 2000], [50, 30, 20]);
    expect(ev[1]).toBe(0);
    expect(ev[0]).toBeCloseTo(icmEquity([5000, 3000, 2000], [50, 30, 20])[0], 12);
  });

  it('matches the textbook 3-player example', () => {
    const ev = icmEquity([5000, 3000, 2000], [50, 30, 20]);
    [38.39, 32.75, 28.86].forEach((x, i) => expect(Math.abs(ev[i] - x)).toBeLessThan(0.01));
  });

  it('pays the chip leader below and the short stack above their chip share', () => {
    const stacks = [6000, 2500, 1000, 500];
    const payouts = [50, 30, 20];
    const ev = icmEquity(stacks, payouts);
    const chips = sum(stacks);
    expect(ev[0] / 100).toBeLessThan(stacks[0] / chips);
    expect(ev[3] / 100).toBeGreaterThan(stacks[3] / chips);
  });

  it('finish probabilities are a proper distribution', () => {
    const probs = finishProbabilities([5000, 3000, 2000, 1000]);
    for (const row of probs) expect(sum(row)).toBeCloseTo(1, 12);
    for (let place = 0; place < 4; place++) expect(sum(probs.map((r) => r[place]))).toBeCloseTo(1, 12);
    expect(probs[0][0]).toBeCloseTo(5000 / 11000, 12);
  });

  it('handles 10 players with 9 payouts in under 50 ms', () => {
    const stacks = [9000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1500, 1000];
    const payouts = [30, 20, 14, 10, 8, 6, 5, 4, 3];
    const t0 = performance.now();
    const ev = icmEquity(stacks, payouts);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
    expect(sum(ev)).toBeCloseTo(100, 9);
  });

  it('validates input', () => {
    expect(() => icmEquity([1000, -5], [50, 50])).toThrow(/Stack of player 2/);
    expect(() => icmEquity([0, 0], [50, 50])).toThrow(/needs chips/);
    expect(() => icmEquity([1000, 500], [30, 50])).toThrow(/larger/);
    expect(() => icmEquity([1000, 500], [0, 0])).toThrow(/more than 0/);
    expect(() => icmEquity(new Array(13).fill(100), [50, 30, 20])).toThrow(/final table/);
    expect(() => payoutsFromPercent([60, 30, 20], 1000)).toThrow(/more than 100%/);
    expect(payoutsFromPercent([50, 30, 20], 1000)).toEqual([500, 300, 200]);
    expect(() => spotEV({ ...bubble, villain: 1, equity: 0.5 })).toThrow(/different players/);
    expect(() => spotEV({ ...bubble, equity: 1.5 })).toThrow(/Equity/);
    expect(() => spotEV({ ...bubble, stacks: [0, 3000, 3000, 3000], sbSeat: undefined, equity: 0.5 })).toThrow(/Villain has no chips/);
  });

  it('requires more equity than chip EV on the bubble (positive risk premium)', () => {
    const icm = icmRequiredEquity(bubble);
    const chip = chipRequiredEquity(bubble);
    // chip EV: call 2775 to win a pot of 3275 (antes 100 + BB-posted 200 + jam 2975)
    expect(chip).toBeCloseTo(2775 / (3275 + 2775), 12);
    expect(icm).toBeGreaterThan(chip);
    expect(riskPremium(bubble)).toBeCloseTo(icm - chip, 12);
    expect(riskPremium(bubble)).toBeGreaterThan(0.05);
  });

  it('spotEV is linear in equity and icmRequiredEquity is the break-even point', () => {
    const at = (e) => spotEV({ ...bubble, equity: e });
    const [a, b, c] = [0.2, 0.5, 0.8].map(at);
    expect(b.actionEV - a.actionEV).toBeCloseTo(c.actionEV - b.actionEV, 10);
    expect(a.foldEV).toBe(c.foldEV);
    const req = icmRequiredEquity(bubble);
    const r = at(req);
    expect(r.actionEV).toBeCloseTo(r.foldEV, 10);
    expect(r.diff).toBeCloseTo(0, 10);
  });

  it('handles jams with fold equity and ties', () => {
    const jam = { ...bubble, hero: 0, villain: 1, action: 'jam', foldFreq: 0.6, tie: 0.04 };
    const req = icmRequiredEquity(jam);
    const r = spotEV({ ...jam, equity: req });
    expect(r.actionEV).toBeCloseTo(r.foldEV, 10);
    // villain always folding: equity does not matter
    expect(icmRequiredEquity({ ...jam, foldFreq: 1 })).toBeNull();
    // chip EV of folding the small blind is losing it
    expect(spotEV({ ...jam, equity: 0.5 }).chips.foldEV).toBe(3000 - 25 - 100);
  });

  it('pays a busted hero the place they finish in', () => {
    // 3 left, 3 paid: hero (short) calls all-in and loses → 3rd prize, not 0
    const spot = { stacks: [500, 5000, 4500], payouts: [50, 30, 20], hero: 0, villain: 1, action: 'call' };
    const lose = spotEV({ ...spot, equity: 0 });
    expect(lose.actionEV).toBeCloseTo(20, 12);
    const win = spotEV({ ...spot, equity: 1 });
    expect(win.actionEV).toBeCloseTo(icmEquity([1000, 4500, 4500], [50, 30, 20])[0], 12);
  });

  it('handles a big blind ante as dead money', () => {
    const spot = { ...bubble, stacks: [2500, 4100, 1800, 900], blinds: { sb: 100, bb: 200, ante: 200, bbAnte: true } };
    const r = spotEV({ ...spot, equity: 0.5 });
    expect(r.chips.foldEV).toBe(4100 - 200 - 200);
    expect(r.pot).toBe(200 + 2 * 2500); // BB ante + both stacks' live chips (villain covered)
  });

  it('a large bounty lowers the ICM required equity (PKO + ICM)', () => {
    const base = { ...bubble, payouts: [500, 300, 200] };
    const plain = icmRequiredEquity(base);
    const small = icmRequiredEquity({ ...base, bounties: [20, 20, 20, 20], pko: true });
    const large = icmRequiredEquity({ ...base, bounties: [200, 200, 200, 200], pko: true });
    expect(small).toBeLessThan(plain);
    expect(large).toBeLessThan(small);
    // head value adds more
    expect(icmRequiredEquity({ ...base, bounties: [200, 200, 200, 200], pko: { headValueFactor: 1 } })).toBeLessThan(large);
    // no bounty when villain covers hero
    const covered = { ...base, stacks: [3000, 2000, 3000, 3000], bounties: [500, 500, 500, 500] };
    expect(icmRequiredEquity({ ...covered, pko: true })).toBeCloseTo(icmRequiredEquity(covered), 12);
  });

  it('icmDecisionEV wraps spotEV', () => {
    const { stacks, payouts, hero, villain, ...rest } = bubble;
    const r = icmDecisionEV({ stacks, payouts, hero, villain, risk: 'call', outcomes: { equity: 0.55 }, ...rest });
    expect(r).toEqual(spotEV({ ...bubble, equity: 0.55 }));
  });
});
