import { describe, it, expect } from 'vitest';
import { combosForClass, expandRange, comboIndex, comboWeights, countCombos, COMBO_CARDS } from '../src/engine/combos.js';
import { parseCards, cardToString } from '../src/engine/cards.js';
import { handClasses } from '../src/engine/ranges.js';

const str = (pairs) => pairs.map(([a, b]) => cardToString(a) + cardToString(b));

describe('combos', () => {
  it('expands classes into specific combos', () => {
    expect(str(combosForClass('AKs'))).toEqual(['AsKs', 'AhKh', 'AdKd', 'AcKc']);
    expect(combosForClass('AA')).toHaveLength(6);
    expect(combosForClass('AKo')).toHaveLength(12);
    let total = 0;
    for (const cls of handClasses()) total += combosForClass(cls).length;
    expect(total).toBe(1326);
  });

  it('applies card removal', () => {
    expect(combosForClass('AKs', parseCards('As'))).toHaveLength(3);
    expect(combosForClass('AKs', 'As')).toHaveLength(3);
    expect(combosForClass('AA', 'As')).toHaveLength(3);
    expect(combosForClass('AA', 'AsAh')).toHaveLength(1);
    expect(combosForClass('AKo', 'AsKd')).toHaveLength(7);
    expect(combosForClass('72o', 'Qh')).toHaveLength(12);
  });

  it('expands weighted ranges with card removal', () => {
    const combos = expandRange('AKs:0.5, QQ', 'Qs');
    expect(combos).toHaveLength(4 + 3);
    expect(combos.filter((c) => c.weight === 0.5)).toHaveLength(4);
    expect(combos.every((c) => !c.cards.includes(parseCards('Qs')[0]))).toBe(true);
    expect(countCombos('22+, A2+, K2+, Q2+, J2+, T2+, 92+, 82+, 72+, 62+, 52+, 42+, 32', 'AsKd')).toBe(1225);
    expect(str(expandRange('AKs, AsKs:0').map((c) => c.cards))).toEqual(['AhKh', 'AdKd', 'AcKc']);
  });

  it('indexes all 1326 combos uniquely', () => {
    const seen = new Set();
    for (let a = 0; a < 52; a++) {
      for (let b = 0; b < a; b++) {
        const i = comboIndex(a, b);
        expect(comboIndex(b, a)).toBe(i);
        expect([COMBO_CARDS[2 * i], COMBO_CARDS[2 * i + 1]]).toEqual([a, b]);
        seen.add(i);
      }
    }
    expect(seen.size).toBe(1326);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(1325);
  });

  it('builds per-combo weights', () => {
    const w = comboWeights('AKs:0.5, AsKs');
    const [as, ks, ah, kh] = parseCards('AsKsAhKh');
    expect(w[comboIndex(as, ks)]).toBe(1);
    expect(w[comboIndex(ah, kh)]).toBe(0.5);
    expect(w.reduce((x, y) => x + y, 0)).toBe(2.5);
  });
});
