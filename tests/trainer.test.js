import { describe, it, expect } from 'vitest';
import { nextSpot, scoreAnswer, edgeClasses, updateReview, updateStats, accuracy } from '../src/preflop/trainer.js';
import { loadChart, duplicateChart, chartAction, spotFrequencies, BASELINE_ID } from '../src/preflop/charts.js';
import { createRng } from '../src/engine/rng.js';
import { cardToString } from '../src/engine/cards.js';

const chart = loadChart(BASELINE_ID);
const nonThreeBet = Object.keys(chart.spots).filter((id) => !id.startsWith('vs3bet'));

describe('trainer dealing', () => {
  it('is reproducible with a fixed seed', () => {
    const deal = (seed) => {
      const rng = createRng(seed);
      return Array.from({ length: 50 }, () => nextSpot(chart, { rng }));
    };
    expect(deal(7)).toEqual(deal(7));
    expect(deal(7)).not.toEqual(deal(8));
  });

  it('deals hands in proportion to their combos', () => {
    const rng = createRng(2024);
    const N = 100000;
    let pairs = 0;
    let suited = 0;
    for (let i = 0; i < N; i++) {
      const { handClass } = nextSpot(chart, { rng, spots: nonThreeBet });
      if (handClass.length === 2) pairs++;
      else if (handClass.endsWith('s')) suited++;
    }
    expect(Math.abs(pairs / N - 78 / 1326)).toBeLessThan(0.01);
    expect(Math.abs(suited / N - 312 / 1326)).toBeLessThan(0.01);
  });

  it('deals real cards that match the class', () => {
    const rng = createRng(3);
    for (let i = 0; i < 200; i++) {
      const s = nextSpot(chart, { rng });
      const [a, b] = s.cards.map(cardToString);
      expect(a).not.toBe(b);
      const ranks = [a[0], b[0]];
      expect(s.handClass.startsWith(ranks[0]) || s.handClass.startsWith(ranks[1])).toBe(true);
      if (s.handClass.endsWith('s')) expect(a[1]).toBe(b[1]);
      if (s.handClass.endsWith('o')) expect(a[1]).not.toBe(b[1]);
    }
  });

  it('respects spot filters', () => {
    const rng = createRng(11);
    const spots = ['vsOpen:BB:BTN', 'RFI:CO'];
    const seen = new Set();
    for (let i = 0; i < 300; i++) seen.add(nextSpot(chart, { rng, spots }).spotId);
    expect([...seen].sort()).toEqual([...spots].sort());
    expect(() => nextSpot(chart, { rng, spots: ['vs3bet:SB:XX'] })).toThrow(/No spots/);
  });

  it('only deals opened hands when facing a 3-bet', () => {
    const rng = createRng(5);
    const opens = spotFrequencies(chart, 'RFI:UTG').raise;
    const classes = Object.fromEntries(Object.keys(chart.spots).map((x) => [x, 0]));
    for (let i = 0; i < 2000; i++) {
      const s = nextSpot(chart, { rng, spots: ['vs3bet:UTG:BTN'] });
      expect(chartAction(chart, 'RFI:UTG', s.handClass).raise).toBeGreaterThan(0);
      classes[s.spotId]++;
    }
    expect(opens.some((x) => x === 0)).toBe(true);
  });

  it('deals only edge hands when asked', () => {
    const rng = createRng(9);
    const edges = edgeClasses(chart, 'RFI:BTN');
    expect(edges.size).toBeGreaterThan(10);
    expect(edges.size).toBeLessThan(120);
    expect(edges.has('AA')).toBe(false);
    expect(edges.has('Q8o')).toBe(true); // mixed at 50%
    for (let i = 0; i < 300; i++) {
      expect(edges.has(nextSpot(chart, { rng, spots: ['RFI:BTN'], focus: 'edges' }).handClass)).toBe(true);
    }
  });
});

describe('trainer scoring', () => {
  it('marks answers correct, acceptable or wrong at the thresholds', () => {
    const c = duplicateChart(chart);
    c.spots['vsOpen:BB:BTN'] = { raise: 'AKs, KQs:0.15, QJs:0.14, JTs:0.5', call: 'KQs:0.85, QJs:0.86, JTs:0.5' };
    const spot = (handClass) => ({ spotId: 'vsOpen:BB:BTN', handClass });
    expect(scoreAnswer(c, spot('AKs'), 'raise')).toMatchObject({ correct: true, verdict: 'correct', frequency: 1 });
    expect(scoreAnswer(c, spot('AKs'), 'call').verdict).toBe('wrong');
    expect(scoreAnswer(c, spot('JTs'), 'raise').verdict).toBe('correct'); // exactly 0.5
    expect(scoreAnswer(c, spot('JTs'), 'call').verdict).toBe('correct');
    expect(scoreAnswer(c, spot('KQs'), 'raise').verdict).toBe('acceptable'); // exactly 0.15
    expect(scoreAnswer(c, spot('QJs'), 'raise').verdict).toBe('wrong'); // 0.14
    expect(scoreAnswer(c, spot('72o'), 'fold')).toMatchObject({ verdict: 'correct', best: 'fold' });
    const r = scoreAnswer(c, spot('KQs'), 'call');
    expect(r.frequencies).toEqual({ raise: 0.15, call: 0.85, allin: 0, fold: 0 });
    expect(() => scoreAnswer(c, spot('AA'), 'limp')).toThrow();
  });
});

describe('spaced repetition and stats', () => {
  const spot = { spotId: 'RFI:CO', handClass: 'A8o' };

  it('brings wrong answers back sooner, then less often', () => {
    let review = updateReview([], spot, 'wrong', 10);
    expect(review).toEqual([{ ...spot, gap: 3, due: 13 }]);
    const rng = createRng(1);
    expect(nextSpot(chart, { rng, review, deal: 12 }).fromReview).toBe(false);
    const due = nextSpot(chart, { rng, review, deal: 13 });
    expect(due).toMatchObject({ fromReview: true, spotId: 'RFI:CO', handClass: 'A8o' });
    review = updateReview(review, spot, 'correct', 13);
    expect(review[0]).toMatchObject({ gap: 6, due: 19 });
    review = updateReview(review, spot, 'correct', 19); // 12
    review = updateReview(review, spot, 'correct', 31); // 24
    expect(review[0].gap).toBe(24);
    review = updateReview(review, spot, 'acceptable', 55);
    expect(review).toEqual([]);
    expect(updateReview([], spot, 'correct', 1)).toEqual([]);
  });

  it('keeps per-spot stats', () => {
    let stats = {};
    stats = updateStats(stats, spot, 'correct');
    stats = updateStats(stats, spot, 'wrong');
    stats = updateStats(stats, { ...spot, handClass: 'K4s' }, 'wrong');
    stats = updateStats(stats, spot, 'acceptable');
    expect(stats['RFI:CO']).toEqual({ attempts: 4, correct: 1, acceptable: 1, wrong: 2, recentMistakes: ['K4s', 'A8o'] });
    expect(accuracy(stats['RFI:CO'])).toBeCloseTo(1.5 / 4, 12);
    expect(accuracy({ attempts: 0, correct: 0, acceptable: 0 })).toBe(0);
  });
});
