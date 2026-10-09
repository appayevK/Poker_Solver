import { describe, it, expect } from 'vitest';
import {
  handClasses,
  parseRange,
  rangeToString,
  rangePercent,
  rangeCombos,
  comboWeight,
  classAt,
  setClassWeight,
} from '../src/engine/ranges.js';
import { parseCards } from '../src/engine/cards.js';

const combos = (s) => rangeCombos(parseRange(s));
const ALL = '22+, A2+, K2+, Q2+, J2+, T2+, 92+, 82+, 72+, 62+, 52+, 42+, 32';

describe('ranges', () => {
  it('lists the 169 classes in grid order', () => {
    const classes = handClasses();
    expect(classes).toHaveLength(169);
    expect(new Set(classes).size).toBe(169);
    expect(classes[0]).toBe('AA');
    expect(classes[1]).toBe('AKs'); // above the diagonal: suited
    expect(classes[13]).toBe('AKo'); // below the diagonal: offsuit
    expect(classes[12]).toBe('A2s');
    expect(classes[14]).toBe('KK');
    expect(classes[168]).toBe('22');
    for (let i = 0; i < 13; i++) expect(classes[i * 13 + i]).toHaveLength(2);
    expect(classAt(2, 5)).toBe('Q9s');
    expect(classAt(5, 2)).toBe('Q9o');
  });

  it('counts combos for the standard notations', () => {
    expect(combos('22+')).toBe(78);
    expect(combos('A2s+')).toBe(48);
    expect(combos('KTo+')).toBe(36);
    expect(combos('AK')).toBe(16);
    expect(combos('AKs')).toBe(4);
    expect(combos('AKo')).toBe(12);
    expect(combos('QQ')).toBe(6);
    expect(combos('QQ+')).toBe(18);
    expect(combos('QQ-99')).toBe(24);
    expect(combos('99-QQ')).toBe(24);
    expect(combos('T9s-65s')).toBe(20);
    expect(combos('A5s-A2s')).toBe(16);
    expect(combos('AsKs')).toBe(1);
    expect(combos(ALL)).toBe(1326);
    expect(rangePercent(parseRange(ALL))).toBe(1);
  });

  it('expands plus and dash ranges to the right classes', () => {
    expect([...parseRange('KTo+').keys()].sort()).toEqual(['KJo', 'KQo', 'KTo']);
    expect([...parseRange('T9s-65s').keys()].sort()).toEqual(['65s', '76s', '87s', '98s', 'T9s']);
    expect([...parseRange('A5s-A2s').keys()].sort()).toEqual(['A2s', 'A3s', 'A4s', 'A5s']);
    expect([...parseRange('JJ+').keys()].sort()).toEqual(['AA', 'JJ', 'KK', 'QQ']);
  });

  it('applies weights', () => {
    const r = parseRange('A5s:0.5, AKs, KQo:25%');
    expect(r.get('A5s')).toBe(0.5);
    expect(r.get('AKs')).toBe(1);
    expect(r.get('KQo')).toBe(0.25);
    expect(rangeCombos(r)).toBe(2 + 4 + 3);
    expect(rangePercent(r)).toBeCloseTo(9 / 1326, 12);
    expect(combos('QQ+:0.5')).toBe(9);
  });

  it('supports specific combos as overrides of class weights', () => {
    const r = parseRange('AKs, AsKs:0');
    expect(rangeCombos(r)).toBe(3);
    const [as, ks, ah, kh] = parseCards('AsKsAhKh');
    expect(comboWeight(r, as, ks)).toBe(0);
    expect(comboWeight(r, ah, kh)).toBe(1);
    expect(rangeCombos(parseRange('AKs:0.5, AhKh'))).toBe(2.5);
    expect(rangeCombos(parseRange('AsKs, AhKh, AdKd'))).toBe(3);
    // a later class token resets the combos inside it
    expect(rangeCombos(parseRange('AsKs:0, AKs'))).toBe(4);
    // redundant overrides are dropped
    expect(parseRange('AKs, AsKs').size).toBe(1);
  });

  it('later tokens override earlier ones', () => {
    expect(parseRange('AKs, AKs:0.5').get('AKs')).toBe(0.5);
    expect(parseRange('22+, 55:0').has('55')).toBe(false);
  });

  it('is whitespace tolerant', () => {
    const r = parseRange('  QQ +,AKs ;  T9s - 65s  A5s : 0.5\nKTo+ ');
    expect(rangeToString(r)).toBe(rangeToString(parseRange('QQ+, AKs, T9s-65s, A5s:0.5, KTo+')));
    expect(parseRange('').size).toBe(0);
    expect(parseRange('   ').size).toBe(0);
  });

  it('throws on invalid notation', () => {
    for (const bad of ['AKx', 'KKs', 'AK++', 'A5s-K2s', 'QQ-AK', 'AKs:2', 'AKs:-1', 'AKs:abc', 'AsAs', 'Ax', 'AKs-AKo']) {
      expect(() => parseRange(bad), bad).toThrow();
    }
  });

  it('formats compact notation', () => {
    expect(rangeToString(parseRange(ALL))).toBe(ALL);
    expect(rangeToString(parseRange('AKs, AKo'))).toBe('AK');
    expect(rangeToString(parseRange('QQ, KK, AA'))).toBe('QQ+');
    expect(rangeToString(parseRange('A2s, A3s, A4s, A5s'))).toBe('A5s-A2s');
    expect(rangeToString(parseRange('KTo, KJo, KQo'))).toBe('KTo+');
    expect(rangeToString(parseRange('T9s, 98s, 87s'))).toBe('T9s-87s');
    expect(rangeToString(parseRange('AsKs'))).toBe('AsKs');
    expect(rangeToString(new Map())).toBe('');
  });

  it('round-trips through parseRange', () => {
    const samples = [
      ALL,
      '22+, A2s+, KTo+, 76s',
      'QQ-99, AKs, AsKd, T9s-65s:0.5, A5s-A2s:0.25',
      'JJ+:0.75, AQ+, KQs, AKs, AsKs:0, 72o:0.1',
      'AhKh, 7c2d:0.3',
      'K9s+, Q9s+, J9s+, T8s+, 97s+, 86s+, 75s+, 64s+, 53s+',
    ];
    for (const s of samples) {
      const r = parseRange(s);
      const text = rangeToString(r);
      expect(new Map(parseRange(text)), s).toEqual(r);
    }
  });

  it('round-trips random weighted ranges', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 4294967296;
    };
    const classes = handClasses();
    for (let t = 0; t < 200; t++) {
      const r = new Map();
      for (const cls of classes) {
        const x = rand();
        if (x < 0.4) setClassWeight(r, cls, 1);
        else if (x < 0.5) setClassWeight(r, cls, Math.round(rand() * 100) / 100);
      }
      expect(parseRange(rangeToString(r))).toEqual(r);
    }
  });
});
