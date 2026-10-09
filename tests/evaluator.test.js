import { describe, it, expect } from 'vitest';
import { evaluate, handCategory, BoardEvaluator, CATEGORY_NAMES } from '../src/engine/evaluator.js';
import { parseCards } from '../src/engine/cards.js';

const ev = (s) => evaluate(parseCards(s));
const cat = (s) => handCategory(ev(s));

function countCategories(size) {
  const counts = Object.fromEntries(CATEGORY_NAMES.map((n) => [n, 0]));
  const hand = new Array(size);
  const rec = (start, depth) => {
    if (depth === size) {
      counts[handCategory(evaluate(hand))]++;
      return;
    }
    for (let c = start; c <= 52 - size + depth; c++) {
      hand[depth] = c;
      rec(c + 1, depth + 1);
    }
  };
  rec(0, 0);
  return counts;
}

describe('evaluator', () => {
  it('counts every 5-card hand category exactly', () => {
    expect(countCategories(5)).toEqual({
      'Straight flush': 40,
      Quads: 624,
      'Full house': 3744,
      Flush: 5108,
      Straight: 10200,
      Trips: 54912,
      'Two pair': 123552,
      Pair: 1098240,
      'High card': 1302540,
    });
  });

  it.skipIf(!process.env.SLOW_TESTS)(
    'counts every 7-card hand category exactly (slow: SLOW_TESTS=1)',
    () => {
      expect(countCategories(7)).toEqual({
        'Straight flush': 41584,
        Quads: 224848,
        'Full house': 3473184,
        Flush: 4047644,
        Straight: 6180020,
        Trips: 6461620,
        'Two pair': 31433400,
        Pair: 58627800,
        'High card': 23294460,
      });
    },
    600_000,
  );

  it('names categories', () => {
    expect(cat('AsKsQsJsTs')).toBe('Straight flush');
    expect(cat('AsAhAdAcKs')).toBe('Quads');
    expect(cat('AsAhAdKcKs')).toBe('Full house');
    expect(cat('As9s7s4s2s')).toBe('Flush');
    expect(cat('9s8h7d6c5s')).toBe('Straight');
    expect(cat('7s7h7d4c2s')).toBe('Trips');
    expect(cat('7s7h4d4c2s')).toBe('Two pair');
    expect(cat('7s7h5d4c2s')).toBe('Pair');
    expect(cat('As9h7d4c2s')).toBe('High card');
  });

  it('ranks categories in order', () => {
    const hands = ['As9h7d4c2s', '7s7h5d4c2s', '7s7h4d4c2s', '7s7h7d4c2s', '9s8h7d6c5s', 'As9s7s4s2s', 'AsAhAdKcKs', 'AsAhAdAcKs', '5s4s3s2sAs'];
    for (let i = 1; i < hands.length; i++) expect(ev(hands[i])).toBeGreaterThan(ev(hands[i - 1]));
  });

  it('treats the wheel as the lowest straight', () => {
    const wheel = ev('As2d3h4c5s');
    expect(handCategory(wheel)).toBe('Straight');
    expect(ev('2d3h4c5s6s')).toBeGreaterThan(wheel);
    expect(wheel).toBeGreaterThan(ev('AsAdAhKc2s')); // still beats trips
    expect(ev('AsKdQhJcTs')).toBeGreaterThan(ev('KdQhJcTs9s'));
    // steel wheel is the lowest straight flush
    expect(ev('As2s3s4s5s')).toBeLessThan(ev('2s3s4s5s6s'));
    expect(handCategory(ev('As2s3s4s5s'))).toBe('Straight flush');
    // A-K-Q-J + 2 is not a straight
    expect(cat('AsKdQhJc2s')).toBe('High card');
  });

  it('picks the best 5 of 7 cards', () => {
    expect(cat('AsKsQsJs9s8h7d')).toBe('Flush');
    expect(cat('9s8s7s6s5s4s3d')).toBe('Straight flush');
    expect(ev('9s8s7s6s5s4s3d')).toBe(ev('9s8s7s6s5s'));
    expect(ev('AsAhKdKcQsQh2d')).toBe(ev('AsAhKdKcQs')); // three pairs: best two + kicker from the third
    expect(ev('AsAhAdKcKsKh2d')).toBe(ev('AsAhAdKcKs')); // two trips make the best full house
    expect(ev('7s7h7d7c2s3d9h')).toBe(ev('7s7h7d7c9h'));
    expect(ev('2c3d4h5s6c7dAs')).toBe(ev('3d4h5s6c7d')); // highest straight, not the wheel
    expect(ev('2s3s4s5s6s7d8d')).toBeGreaterThan(ev('AsKdQhJcTs')); // straight flush over a straight
  });

  it('evaluates 6-card hands', () => {
    expect(ev('AsAhKdKc2s2d')).toBe(ev('AsAhKdKc2s'));
    expect(cat('AsKsQsJsTs9s')).toBe('Straight flush');
  });

  it('compares kickers', () => {
    expect(ev('AsKd9h7c3s')).toBeGreaterThan(ev('AsQd9h7c3s'));
    expect(ev('AsKd9h7c3s')).toBeGreaterThan(ev('AsKd9h7c2s'));
    expect(ev('AsAdKh7c3s')).toBeGreaterThan(ev('AsAdQhJcTs'));
    expect(ev('AsAdKh7c3s')).toBeGreaterThan(ev('KsKdAhQcJs'));
    expect(ev('AsAdKhKc3s')).toBeGreaterThan(ev('AsAdKhKc2s'));
    expect(ev('AsAdKhKc2s')).toBeGreaterThan(ev('AsAdQhQcJs'));
    expect(ev('7s7d7hAc2s')).toBeGreaterThan(ev('7s7d7hKcQs'));
    expect(ev('7s7d7hAcKs')).toBeGreaterThan(ev('7s7d7hAcQs'));
    expect(ev('7s7d7h2c2s')).toBeGreaterThan(ev('6s6d6hAcAs'));
    expect(ev('7s7d7hAcAs')).toBeGreaterThan(ev('7s7d7hKcKs'));
    expect(ev('8s8d8h8cAs')).toBeGreaterThan(ev('8s8d8h8cKs'));
    expect(ev('As9s7s4s3s')).toBeGreaterThan(ev('As9s7s4s2s'));
  });

  it('splits pots on equal hands', () => {
    expect(ev('AsKdQhJcTs')).toBe(ev('AhKcQdJsTh'));
    expect(ev('As9h7d4c2s')).toBe(ev('Ad9c7h4s2d'));
    // board plays: royal flush on board, hole cards irrelevant
    expect(ev('AsKsQsJsTs2c3d')).toBe(ev('AsKsQsJsTs9h9d'));
    // same two pair, kicker decides or ties
    expect(ev('KsKdQhQc9s2c3d')).toBe(ev('KsKdQhQc9s4c5d'));
  });

  it('BoardEvaluator matches evaluate()', () => {
    const be = new BoardEvaluator();
    let seed = 12345;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed % n;
    };
    for (let t = 0; t < 20000; t++) {
      const cards = [];
      while (cards.length < 7) {
        const c = rand(52);
        if (!cards.includes(c)) cards.push(c);
      }
      be.setBoard(cards.slice(0, 5));
      expect(be.evalHole(cards[5], cards[6])).toBe(evaluate(cards));
    }
  });
});
