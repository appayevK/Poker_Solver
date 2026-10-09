import { describe, it, expect } from 'vitest';
import {
  headsUpPushFold,
  tablePushFold,
  multiwayPushFold,
  nashAction,
  normalizeSpot,
  buildGame,
  terminalValues,
  positionLabels,
} from '../src/nash/pushfold.js';
import { solve } from '../src/nash/fictitious-play.js';
import { rangePercent, classIndex } from '../src/engine/ranges.js';

const share = (range) => rangePercent(range);
const hu = {};
const heads = (stackBB, extra = {}) => {
  const key = JSON.stringify({ stackBB, ...extra });
  hu[key] ??= headsUpPushFold({ stackBB, ...extra });
  return hu[key];
};

describe('push/fold heads-up', () => {
  it('converges to below 0.001 bb exploitability at 10 bb in under 1 s', () => {
    const t0 = performance.now();
    const r = headsUpPushFold({ stackBB: 10 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.exploitability).toBeLessThan(0.001);
    expect(r.converged).toBe(true);
  });

  it('matches published Nash ranges at 10 bb (SB jams ~58%, BB calls ~37%)', () => {
    const r = heads(10);
    expect(share(r.sbJam)).toBeGreaterThan(0.5);
    expect(share(r.sbJam)).toBeLessThan(0.65);
    expect(share(r.bbCall)).toBeGreaterThan(0.3);
    expect(share(r.bbCall)).toBeLessThan(0.45);
  });

  it('AA always jams and always calls', () => {
    for (const stack of [5, 10, 15, 20]) {
      const r = heads(stack);
      expect(r.sbJam.get('AA')).toBe(1);
      expect(r.bbCall.get('AA')).toBe(1);
    }
  });

  it('the SB jams everything at 1 bb', () => {
    expect(share(heads(1).sbJam)).toBe(1);
  });

  it('jam and call ranges tighten as stacks get deeper', () => {
    const rs = [5, 10, 15, 20].map((s) => heads(s));
    for (let i = 1; i < rs.length; i++) {
      expect(share(rs[i].sbJam)).toBeLessThan(share(rs[i - 1].sbJam));
      expect(share(rs[i].bbCall)).toBeLessThan(share(rs[i - 1].bbCall));
    }
  });

  it('an ante widens the SB jam range', () => {
    expect(share(heads(10, { ante: 0.125 }).sbJam)).toBeGreaterThan(share(heads(10).sbJam));
    expect(share(heads(10, { ante: 1, bbAnte: true }).sbJam)).toBeGreaterThan(share(heads(10).sbJam));
  });

  it('reports per-class EVs consistent with the strategies', () => {
    const r = heads(10);
    const aa = classIndex('AA');
    const o72 = classIndex('72o');
    expect(r.evs.sbJam[aa]).toBeGreaterThan(r.evs.sbFold);
    expect(r.evs.sbFold).toBeCloseTo(-0.5, 12);
    expect(r.evs.bbFold[o72]).toBeCloseTo(-1, 12);
    expect(r.evs.bbCall[o72]).toBeLessThan(r.evs.bbFold[o72]);
  });
});

describe('push/fold table', () => {
  it('names positions in action order', () => {
    expect(positionLabels(2)).toEqual(['SB', 'BB']);
    expect(positionLabels(3)).toEqual(['BTN', 'SB', 'BB']);
    expect(positionLabels(9)[0]).toBe('UTG');
  });

  it('a 2-seat table is the heads-up game', () => {
    const t = tablePushFold({ stacks: [10, 10] });
    expect(share(t.seats[0].openJam)).toBeCloseTo(share(heads(10).sbJam), 2);
  });

  it('converges 3-handed at 10 bb, and the BTN jams tighter than a heads-up SB', () => {
    const r = tablePushFold({ stacks: [10, 10, 10] });
    expect(r.converged).toBe(true);
    for (const e of r.exploitability) expect(e).toBeLessThan(0.002);
    expect(share(r.seats[0].openJam)).toBeLessThan(share(heads(10).sbJam));
    // every seat calls a BTN jam tighter than the BB calls a heads-up SB jam
    expect(share(r.seats[2].callVs[0])).toBeLessThan(share(heads(10).bbCall));
  });

  it('chip values of every outcome sum to zero', () => {
    const V = terminalValues(normalizeSpot({ stacks: [12, 7, 20, 9], blinds: { ante: 0.2 } }));
    const sum = (v) => v.reduce((a, b) => a + b, 0);
    expect(sum(V.walk)).toBeCloseTo(0, 12);
    for (let i = 0; i < 3; i++) {
      expect(sum(V.steal[i])).toBeCloseTo(0, 12);
      for (let k = i + 1; k < 4; k++) {
        expect(sum(V.win[i][k])).toBeCloseTo(0, 12);
        expect(sum(V.lose[i][k])).toBeCloseTo(0, 12);
      }
    }
    // BTN (seat 1, 7 bb) jams and the SB (seat 2, 20 bb) calls. Winning, the BTN takes the SB's
    // matched 6.8, the three other antes and the BB's blind: +8.4 bb.
    expect(V.win[1][2][1]).toBeCloseTo(6.8 + 0.6 + 1, 12);
  });

  it('ICM on the bubble calls tighter than chip EV', () => {
    const stacks = [10, 10, 10, 10];
    const chip = tablePushFold({ stacks });
    const icm = tablePushFold({ stacks, mode: 'icm', payouts: [50, 30, 20] });
    expect(icm.converged).toBe(true);
    for (let seat = 1; seat < 4; seat++) {
      for (let jammer = 0; jammer < seat; jammer++) {
        expect(share(icm.seats[seat].callVs[jammer])).toBeLessThan(share(chip.seats[seat].callVs[jammer]));
      }
    }
  });

  it('PKO bounties widen calls for a player who covers the jammer, not for one who is covered', () => {
    // BTN 10 bb, SB 5 bb (covered by the BTN), BB 20 bb (covers everyone); one more player out of the hand.
    const spot = { stacks: [10, 5, 20], payouts: [500, 300, 200], otherStacks: [10] };
    const plain = tablePushFold({ ...spot, mode: 'icm' });
    const pko = tablePushFold({ ...spot, mode: 'pko', bounties: [200, 200, 200] });
    expect(share(pko.seats[2].callVs[1])).toBeGreaterThan(share(plain.seats[2].callVs[1]));
    expect(share(pko.seats[2].callVs[0])).toBeGreaterThan(share(plain.seats[2].callVs[0]));
    expect(share(pko.seats[1].callVs[0])).toBeLessThanOrEqual(share(plain.seats[1].callVs[0]));
  });

  it('bounties change the EV gap only for the player who can bust the jammer', () => {
    // Fixed strategies: compare call gaps with and without bounties (chip-EV PKO, 1 $ = 1 bb).
    const base = { stacks: [10, 5, 20] };
    const evaluateAt = (params) => {
      const game = buildGame(normalizeSpot(params));
      return { game, out: game.evaluate(game.nodes.map(() => new Float64Array(169).fill(0.3))) };
    };
    const { game, out: plain } = evaluateAt({ ...base, mode: 'pko', bounties: [0, 0, 0], bountyRate: 1 });
    const { out: bounty } = evaluateAt({ ...base, mode: 'pko', bounties: [4, 4, 4], bountyRate: 1 });
    const node = (id) => game.nodes.findIndex((x) => x.id === id);
    const covered = node('call:0:1'); // SB (5 bb) vs BTN (10 bb) jam: cannot bust the BTN
    const covering = node('call:0:2'); // BB (20 bb) vs BTN jam: busts the BTN by winning
    for (let c = 0; c < 169; c += 13) {
      expect(bounty.gaps[covered][c]).toBeCloseTo(plain.gaps[covered][c], 10);
      expect(bounty.gaps[covering][c]).toBeGreaterThan(plain.gaps[covering][c]);
    }
  });

  it('solves 9-handed at 15 bb in under 15 s', () => {
    const t0 = performance.now();
    const r = tablePushFold({ stacks: new Array(9).fill(15) });
    expect(performance.now() - t0).toBeLessThan(15000);
    expect(r.converged).toBe(true);
    // earlier positions jam tighter
    expect(share(r.seats[0].openJam)).toBeLessThan(share(r.seats[6].openJam));
    expect(share(r.seats[6].openJam)).toBeLessThan(share(r.seats[7].openJam));
  });

  it('nashAction jams AA and folds 72o in a 15 bb open spot', () => {
    const r = tablePushFold({ stacks: [15, 15, 15, 15, 15, 15] });
    const aa = nashAction(r, { seat: 0, node: 'open', handClass: 'AA' });
    expect(aa.action).toBe('jam');
    expect(aa.evGap).toBeGreaterThan(0);
    const trash = nashAction(r, { seat: 0, node: 'open', handClass: '7c2d' });
    expect(trash.action).toBe('fold');
    expect(trash.evGap).toBeLessThan(0);
    expect(nashAction(r, { seat: 5, node: { vs: 4 }, handClass: 'AA' }).action).toBe('call');
    expect(() => nashAction(r, { seat: 5, node: 'open', handClass: 'AA' })).toThrow(/No decision/);
  });

  it('multiwayPushFold wraps tablePushFold', () => {
    const a = multiwayPushFold({ stacks: [8, 8, 8], ante: 0.1 });
    const b = tablePushFold({ stacks: [8, 8, 8], blinds: { ante: 0.1 } });
    expect(a.nodes.map((x) => x.strategy)).toEqual(b.nodes.map((x) => x.strategy));
  });

  it('validates input', () => {
    expect(() => tablePushFold({ stacks: [10] })).toThrow(/2 to 9/);
    expect(() => tablePushFold({ stacks: new Array(10).fill(10) })).toThrow(/2 to 9/);
    expect(() => tablePushFold({ stacks: [10, 0] })).toThrow(/greater than 0/);
    expect(() => tablePushFold({ stacks: [10, 10], maxCallers: 2 })).toThrow(/maxCallers/);
    expect(() => tablePushFold({ stacks: [10, 10], mode: 'icm' })).toThrow(/Payouts/);
    expect(() => tablePushFold({ stacks: [10, 10], mode: 'pko', bounties: [1] })).toThrow(/bounty per seat/);
    expect(() => tablePushFold({ stacks: [10, 10], mode: 'pko', bounties: [1, 1] })).toThrow(/Starting bounty/);
    expect(() => tablePushFold({ stacks: [10, 10], mode: 'gto' })).toThrow(/Mode/);
  });
});

describe('fictitious play', () => {
  it('reports progress and supports every averaging rule', () => {
    const game = buildGame(normalizeSpot({ stacks: [10, 10] }));
    const seen = [];
    const r = solve(game, { tolerance: 1e-3, onProgress: (p) => seen.push(p), progressEvery: 5 });
    expect(r.converged).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1).exploitability).toBeLessThan(1e-3);
    for (const averaging of ['1/t', 'fixed']) {
      const x = solve(game, { averaging, iterations: 3000, tolerance: 2e-3, step: 0.05 });
      expect(Math.max(...x.exploitability)).toBeLessThan(2e-3);
    }
    expect(() => solve(game, { averaging: 'nope' })).toThrow(/averaging/);
  });
});
