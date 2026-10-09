import { describe, it, expect } from 'vitest';
import {
  exactEquity,
  monteCarloEquity,
  preflopEquity,
  canonicalBoards,
  chooseMethod,
  sortNumbers,
} from '../src/engine/equity.js';
import { evaluate } from '../src/engine/evaluator.js';
import { parseCards } from '../src/engine/cards.js';
import { expandRange } from '../src/engine/combos.js';

const TOL = 0.003;
const eq = (players, board, dead) => exactEquity(players, board, dead).players.map((p) => p.equity);

/** Independent reference: loop over every combo tuple and every runout with evaluate(). */
function bruteForce(players, board) {
  const b = parseCards(board);
  const lists = players.map((p) => {
    const cards = (() => {
      try {
        return parseCards(p);
      } catch {
        return null;
      }
    })();
    return cards && cards.length === 2 ? [{ cards, weight: 1 }] : expandRange(p, b);
  });
  const k = players.length;
  const win = new Array(k).fill(0);
  const share = new Array(k).fill(0);
  let total = 0;
  const tuple = [];
  const recPlayers = (p, w) => {
    if (p === k) {
      const used = new Set([...b, ...tuple.flatMap((c) => c.cards)]);
      const deck = [];
      for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
      const need = 5 - b.length;
      const run = [];
      const recRunout = (start) => {
        if (run.length === need) {
          const s = tuple.map((t) => evaluate([...b, ...run, ...t.cards]));
          const best = Math.max(...s);
          const winners = s.filter((x) => x === best).length;
          total += w;
          s.forEach((x, q) => {
            if (x !== best) return;
            if (winners === 1) win[q] += w;
            share[q] += w / winners;
          });
          return;
        }
        for (let i = start; i < deck.length; i++) {
          run.push(deck[i]);
          recRunout(i + 1);
          run.pop();
        }
      };
      recRunout(0);
      return;
    }
    for (const combo of lists[p]) {
      if (tuple.some((t) => t.cards.some((c) => combo.cards.includes(c)))) continue;
      tuple.push(combo);
      recPlayers(p + 1, w * combo.weight);
      tuple.pop();
    }
  };
  recPlayers(0, 1);
  return share.map((s) => s / total);
}

describe('equity', () => {
  it('AhAs vs KhKs is about 82.6% / 17.4%', () => {
    const [a, k] = eq(['AhAs', 'KhKs']);
    expect(a).toBeCloseTo(0.826, 2);
    expect(Math.abs(a - 0.826)).toBeLessThan(TOL);
    expect(Math.abs(k - 0.174)).toBeLessThan(TOL);
  });

  it('AA vs KK preflop (classes) is about 81.9%', () => {
    const [a] = eq(['AA', 'KK']);
    expect(Math.abs(a - 0.819)).toBeLessThan(TOL);
  });

  it('AKs vs QQ is roughly a coinflip, QQ about 54%', () => {
    const [, q] = eq(['AKs', 'QQ']);
    expect(Math.abs(q - 0.54)).toBeLessThan(TOL);
  });

  it('22 vs AKo is about 52.5%', () => {
    const [, p] = eq(['AKo', '22']);
    expect(Math.abs(p - 0.525)).toBeLessThan(TOL);
  });

  it('72o vs AA is about 12%', () => {
    const [x] = eq(['72o', 'AA']);
    expect(Math.abs(x - 0.12)).toBeLessThan(TOL);
  });

  it('exact equity on a full board is 0, 0.5 or 1', () => {
    expect(eq(['AsAh', 'KsKh'], 'Ad7c2h3s9d')).toEqual([1, 0]);
    expect(eq(['AsAh', 'KsKh'], 'Kd7c2h3s9d')).toEqual([0, 1]);
    expect(eq(['AsKh', 'AdKc'], 'Qh7c2h3s9d')).toEqual([0.5, 0.5]);
    const r = exactEquity(['AsKh', 'AdKc'], 'Qh7c2h3s9d');
    expect(r.players[0]).toEqual({ win: 0, tie: 1, equity: 0.5 });
    expect(r.runouts).toBe(1);
  });

  it('reports win, tie and equity consistently', () => {
    const r = exactEquity(['AsKs', 'AdKd'], 'Qh7c2h');
    for (const p of r.players) expect(p.equity).toBeCloseTo(p.win + p.tie / 2, 12);
    expect(r.players[0].tie).toBe(r.players[1].tie);
    const sum = eq(['AsAh', 'KsKh', 'QsQh']).reduce((x, y) => x + y, 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it('matches brute force for ranges with weights and card removal (heads-up)', () => {
    const players = ['QQ, JJ:0.5, AsKs', 'AK, 99, Qs7s:0.25'];
    const exact = eq(players, 'Qh7s2s');
    const ref = bruteForce(players, 'Qh7s2s');
    exact.forEach((e, i) => expect(e).toBeCloseTo(ref[i], 10));
  });

  it('matches brute force multiway on the turn', () => {
    const players = ['AsKs', 'QQ, 77', 'JTs, 98s:0.5'];
    const exact = eq(players, 'Qh7s2s3d');
    const ref = bruteForce(players, 'Qh7s2s3d');
    exact.forEach((e, i) => expect(e).toBeCloseTo(ref[i], 10));
  });

  it('hand vs weighted range equals the weighted average of hand vs hand', () => {
    const vsRange = eq(['AsKs', 'QsQh:0.25, QdQc'])[0];
    const e1 = eq(['AsKs', 'QsQh'])[0];
    const e2 = eq(['AsKs', 'QdQc'])[0];
    expect(vsRange).toBeCloseTo((0.25 * e1 + e2) / 1.25, 10);
  });

  it('suit-canonical enumeration agrees with full enumeration', () => {
    const fast = exactEquity(['AKs', 'AA']).players[0].equity;
    const slow = exactEquity(['AKs', 'AA'], [], [], { symmetry: false }).players[0].equity;
    expect(fast).toBeCloseTo(slow, 12);
    const { count, mult } = canonicalBoards();
    expect(count).toBe(134459);
    expect(mult.reduce((x, y) => x + y, 0)).toBe(2598960);
  });

  it('respects dead cards', () => {
    // With all four kings dead KK... is impossible; with three dead only one is not
    expect(() => exactEquity(['AA', 'KK'], [], 'KsKhKd')).toThrow(/no possible hands/);
    const [a] = eq(['AsAh', 'KsKh'], [], 'Ad');
    expect(a).toBeLessThan(0.826);
  });

  it('rejects conflicting input', () => {
    expect(() => exactEquity(['AsKs', 'AsQs'])).toThrow(/both need As/);
    expect(() => exactEquity(['AsKs', 'QQ'], 'As7c2d')).toThrow(/board/);
    expect(() => exactEquity(['AsKs'])).toThrow(/two players/);
    expect(() => exactEquity(['AsKs', 'QQ'], 'AhAh')).toThrow();
    expect(() => exactEquity(['AsKs', 'XX'])).toThrow(/Player 2/);
    expect(() => exactEquity(['AsKs', 'QsQh'], 'Qd7c2d', 'Qd')).toThrow(/Dead card/);
  });

  it('Monte Carlo lands within 3 standard errors of exact', () => {
    const spots = [
      [['AKs', 'QQ'], ''],
      [['AsKs', 'TT+, AQs+'], ''],
      [['AA', 'KK', 'QQ'], ''],
      [['22+, A2s+, KTo+', 'QQ+, AK', 'JTs'], 'Th9s2c'],
    ];
    for (const [players, board] of spots) {
      const exact = exactEquity(players, board).players;
      const mc = monteCarloEquity(players, board, { iterations: 40000, seed: 42 });
      expect(mc.method).toBe('montecarlo');
      mc.players.forEach((p, i) => {
        expect(p.stdErr).toBeGreaterThan(0);
        expect(Math.abs(p.equity - exact[i].equity), players.join(' vs ')).toBeLessThan(3 * p.stdErr);
      });
    }
  });

  it('Monte Carlo is reproducible with a seed', () => {
    const a = monteCarloEquity(['AKs', 'QQ'], [], { iterations: 5000, seed: 7 });
    const b = monteCarloEquity(['AKs', 'QQ'], [], { iterations: 5000, seed: 7 });
    const c = monteCarloEquity(['AKs', 'QQ'], [], { iterations: 5000, seed: 8 });
    expect(a.players).toEqual(b.players);
    expect(a.players).not.toEqual(c.players);
  });

  it('chooses exact enumeration when it is cheap', () => {
    expect(chooseMethod(['AsKd', 'QhQc'])).toBe('exact');
    expect(chooseMethod(['AsKd', 'QhQc', 'JsTs', '9d9c', '8h7h', '6s6d'])).toBe('exact');
    expect(chooseMethod(['AA', 'KK'])).toBe('exact');
    expect(chooseMethod(['22+, A2+, K2+', '22+, A2+, K2+'], 'Kh7s2d')).toBe('exact');
    expect(chooseMethod(['22+, A2+, K2+', '22+, A2+, Q2+'])).toBe('montecarlo');
    expect(chooseMethod(['22+, A2+, K2+', '22+, A2+, Q2+', '22+, A2+, J2+'], 'Kh7s2d')).toBe('montecarlo');
  });

  it('sorts numbers', () => {
    let seed = 3;
    for (const n of [0, 1, 5, 17, 100, 1000]) {
      const a = Float64Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) >>> 0) % 50);
      const expected = Float64Array.from(a).sort();
      sortNumbers(a, 0, n - 1);
      expect(a).toEqual(expected);
    }
  });

  const tableValue = preflopEquity('AA', 'KK');
  it.skipIf(tableValue === null)('preflop table matches known values', () => {
    expect(Math.abs(tableValue - 0.819)).toBeLessThan(TOL);
    expect(Math.abs(preflopEquity('QQ', 'AKs') - 0.54)).toBeLessThan(TOL);
    expect(preflopEquity('AKo', 'AKo')).toBe(0.5);
    expect(preflopEquity('KK', 'AA')).toBeCloseTo(1 - tableValue, 5);
    expect(() => preflopEquity('AKx', 'AA')).toThrow();
  });
});
