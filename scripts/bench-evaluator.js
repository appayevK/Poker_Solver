// Measures hand evaluator throughput.
// Run with: npm run bench

import { evaluate, BoardEvaluator } from '../src/engine/evaluator.js';

const HANDS = 200_000;
const SECONDS = 2;

// Deterministic random 7-card hands (xorshift32).
let seed = 0x9e3779b9;
function rand(n) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) % n;
}

function randomHand(size) {
  const used = new Set();
  const cards = [];
  while (cards.length < size) {
    const c = rand(52);
    if (!used.has(c)) {
      used.add(c);
      cards.push(c);
    }
  }
  return cards;
}

const hands = Array.from({ length: HANDS }, () => randomHand(7));

function bench(label, fn) {
  let evals = 0;
  let sink = 0; // consumed so the JIT cannot drop the work
  for (let i = 0; i < HANDS; i++) sink = (sink + fn(hands[i])) | 0; // warm-up
  const t0 = performance.now();
  let t = t0;
  while (t - t0 < SECONDS * 1000) {
    for (let i = 0; i < HANDS; i++) sink = (sink + fn(hands[i])) | 0;
    evals += HANDS;
    t = performance.now();
  }
  const rate = evals / ((t - t0) / 1000);
  console.log(`${label.padEnd(34)} ${(rate / 1e6).toFixed(1).padStart(6)} M evals/sec  (checksum ${sink})`);
}

bench('evaluate(7 cards)', evaluate);

const be = new BoardEvaluator();
bench('BoardEvaluator setBoard+evalHole', (h) => {
  be.setBoard(h);
  return be.evalHole(h[5], h[6]);
});

// Equity inner loop: one board, many holdings.
bench('BoardEvaluator evalHole only', (h) => be.evalHole(h[5], h[6]));
