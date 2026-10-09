import { describe, it, expect } from 'vitest';
import { PAIRS, compatiblePairs, pairs, CLASS_COMBO_COUNTS, TOTAL_PAIRS, eq } from '../src/nash/card-removal.js';
import { classIndex, handClasses } from '../src/engine/ranges.js';

const ci = (cls) => classIndex(cls);

describe('card removal', () => {
  it('counts compatible combo pairs between classes', () => {
    expect(pairs(ci('AA'), ci('KK'))).toBe(36);
    expect(pairs(ci('AA'), ci('AKs'))).toBe(12);
    expect(pairs(ci('AKs'), ci('AA'))).toBe(12);
    // an offsuit AK (two suits used) leaves 2 suits for a suited AK: 12 x 2
    expect(pairs(ci('AKo'), ci('AKs'))).toBe(24);
    expect(pairs(ci('72o'), ci('KQs'))).toBe(48);
  });

  it('AA vs AA: each of the 6 combos is compatible with exactly 1 other', () => {
    // compatiblePairs counts ordered (combo, combo) pairs, so the total is 6 = 1 per combo.
    expect(pairs(ci('AA'), ci('AA'))).toBe(6);
    expect(pairs(ci('AA'), ci('AA')) / CLASS_COMBO_COUNTS[ci('AA')]).toBe(1);
  });

  it('every row sums to combos(class) x 1225', () => {
    let grand = 0;
    for (let a = 0; a < 169; a++) {
      let row = 0;
      for (let b = 0; b < 169; b++) row += PAIRS[a * 169 + b];
      expect(row).toBe(CLASS_COMBO_COUNTS[a] * 1225);
      grand += row;
    }
    expect(grand).toBe(TOTAL_PAIRS);
  });

  it('is symmetric and matches the nested-array view', () => {
    for (let a = 0; a < 169; a += 7) {
      for (let b = 0; b < 169; b += 5) {
        expect(PAIRS[a * 169 + b]).toBe(PAIRS[b * 169 + a]);
        expect(compatiblePairs[a][b]).toBe(PAIRS[a * 169 + b]);
      }
    }
  });

  it('looks up equities from the preflop table', () => {
    expect(Math.abs(eq(ci('AA'), ci('KK')) - 0.8195)).toBeLessThan(0.001);
    expect(eq(ci('KK'), ci('AA'))).toBeCloseTo(1 - eq(ci('AA'), ci('KK')), 5);
    expect(eq(ci('AKo'), ci('AKo'))).toBe(0.5);
    expect(handClasses()).toHaveLength(169);
  });
});
