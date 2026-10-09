import { describe, it, expect } from 'vitest';
import { parseCard, cardToString, parseCards, deck, RANKS, SUITS } from '../src/engine/cards.js';

describe('cards', () => {
  it('round-trips all 52 cards', () => {
    for (let c = 0; c < 52; c++) {
      const s = cardToString(c);
      expect(parseCard(s)).toBe(c);
      expect(s).toBe(RANKS[c >> 2] + SUITS[c & 3]);
    }
  });

  it('uses rank * 4 + suit encoding', () => {
    expect(parseCard('2c')).toBe(0);
    expect(parseCard('As')).toBe(51);
    expect(parseCard('Kd')).toBe(45);
    expect(cardToString(51)).toBe('As');
  });

  it('is lenient about case and accepts 10 for T', () => {
    expect(parseCard('as')).toBe(51);
    expect(parseCard('tH')).toBe(parseCard('Th'));
    expect(parseCard('10s')).toBe(parseCard('Ts'));
  });

  it('parses card lists with or without separators', () => {
    expect(parseCards('AsKd')).toEqual([51, 45]);
    expect(parseCards('As Kd')).toEqual([51, 45]);
    expect(parseCards(' As, Kd ')).toEqual([51, 45]);
    expect(parseCards('')).toEqual([]);
    expect(parseCards(['As', 45])).toEqual([51, 45]);
  });

  it('throws on invalid input', () => {
    expect(() => parseCard('Xs')).toThrow(/rank/);
    expect(() => parseCard('Ax')).toThrow(/suit/);
    expect(() => parseCard('A')).toThrow();
    expect(() => parseCard('Asd')).toThrow();
    expect(() => cardToString(52)).toThrow();
    expect(() => cardToString(-1)).toThrow();
    expect(() => parseCards('AsKx')).toThrow();
    expect(() => parseCards('AsK')).toThrow();
    expect(() => parseCards('AsAs')).toThrow(/Duplicate/);
    expect(() => parseCards([51, 51])).toThrow(/Duplicate/);
  });

  it('builds a deck without dead cards', () => {
    expect(deck()).toHaveLength(52);
    const d = deck([51, 0]);
    expect(d).toHaveLength(50);
    expect(d).not.toContain(51);
    expect(d).not.toContain(0);
    expect(deck('AsKd')).toHaveLength(50);
  });
});
