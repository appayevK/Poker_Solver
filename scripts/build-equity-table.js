// Generates data/preflop-equity-169.json: equity of every hand class vs every other,
// averaged over all non-conflicting combo matchups, by exact enumeration.
// Run with: npm run build:equity
//
// Instead of enumerating 1.7M boards for each of the ~800k combo matchups, this walks
// the 134,459 suit-canonical 5-card boards once (class totals are invariant under
// suit permutations, so each board counts with its orbit size). On each board all
// 1,081 live combos are evaluated and sorted; sweeping upwards, every combo is
// credited with the combos of each class it beats, using per-card counts to drop
// combos that share a card with it. Ties follow from the totals:
// ties = matchups x C(48,5) - winsA - winsB.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handClasses } from '../src/engine/ranges.js';
import { canonicalBoards, exactEquity } from '../src/engine/equity.js';
import { BoardEvaluator } from '../src/engine/evaluator.js';
import { COMBO_CARDS, COMBO_CLASS } from '../src/engine/combos.js';

const OUT = new URL('../data/preflop-equity-169.json', import.meta.url);
const N = 169;
const BOARDS_PER_MATCHUP = 1712304; // C(48, 5)

const classes = handClasses();
const { cards, mult, count } = canonicalBoards();
const ev = new BoardEvaluator();

const wins = new Float64Array(N * N); // wins[a * N + b]: weighted (combo of a beats combo of b, board) count
const below = new Int32Array(N); // combos per class already passed in the sweep
const belowCard = new Int32Array(52 * N); // same, per card they contain
const keys = new Float64Array(1326);
const board = new Uint8Array(5);
const onBoard = new Uint8Array(52);

const t0 = performance.now();
let lastReport = t0;
for (let i = 0; i < count; i++) {
  for (let t = 0; t < 5; t++) {
    board[t] = cards[5 * i + t];
    onBoard[board[t]] = 1;
  }
  ev.setBoard(board);
  let n = 0;
  for (let h = 0; h < 1326; h++) {
    const a = COMBO_CARDS[2 * h];
    const b = COMBO_CARDS[2 * h + 1];
    if (onBoard[a] || onBoard[b]) continue;
    keys[n++] = ev.evalHole(a, b) * 2048 + h;
  }
  for (let t = 0; t < 5; t++) onBoard[board[t]] = 0;
  const sorted = keys.subarray(0, n).sort();

  below.fill(0);
  belowCard.fill(0);
  const m = mult[i];
  for (let g = 0; g < n; ) {
    const s = Math.floor(sorted[g] / 2048);
    let e = g;
    while (e < n && Math.floor(sorted[e] / 2048) === s) e++;
    if (g > 0) {
      for (let t = g; t < e; t++) {
        const h = sorted[t] % 2048;
        const row = COMBO_CLASS[h] * N;
        const ao = COMBO_CARDS[2 * h] * N;
        const bo = COMBO_CARDS[2 * h + 1] * N;
        for (let k = 0; k < N; k++) wins[row + k] += m * (below[k] - belowCard[ao + k] - belowCard[bo + k]);
      }
    }
    for (let t = g; t < e; t++) {
      const h = sorted[t] % 2048;
      const c = COMBO_CLASS[h];
      below[c]++;
      belowCard[COMBO_CARDS[2 * h] * N + c]++;
      belowCard[COMBO_CARDS[2 * h + 1] * N + c]++;
    }
    g = e;
  }

  const now = performance.now();
  if (now - lastReport > 5000 || i === count - 1) {
    lastReport = now;
    const done = (i + 1) / count;
    const elapsed = (now - t0) / 1000;
    console.log(
      `${(done * 100).toFixed(1).padStart(5)}%  ${i + 1}/${count} boards  ` +
        `${elapsed.toFixed(0)}s elapsed, ~${((elapsed / done) * (1 - done)).toFixed(0)}s left`,
    );
  }
}

// Non-conflicting combo matchups per class pair.
const matchups = new Float64Array(N * N);
for (let h1 = 0; h1 < 1326; h1++) {
  const a = COMBO_CARDS[2 * h1];
  const b = COMBO_CARDS[2 * h1 + 1];
  for (let h2 = 0; h2 < 1326; h2++) {
    const c = COMBO_CARDS[2 * h2];
    const d = COMBO_CARDS[2 * h2 + 1];
    if (c === a || c === b || d === a || d === b) continue;
    matchups[COMBO_CLASS[h1] * N + COMBO_CLASS[h2]]++;
  }
}

const equity = [];
for (let a = 0; a < N; a++) {
  const row = [];
  for (let b = 0; b < N; b++) {
    const total = matchups[a * N + b] * BOARDS_PER_MATCHUP;
    const w = wins[a * N + b];
    const ties = total - w - wins[b * N + a];
    row.push(Math.round(((w + ties / 2) / total) * 1e5) / 1e5);
  }
  equity.push(row);
}

const json =
  '{\n' +
  '"description": "Preflop all-in equity of row class vs column class, exact, averaged over all non-conflicting combo matchups",\n' +
  `"classes": ${JSON.stringify(classes)},\n` +
  '"equity": [\n' +
  equity.map((r) => JSON.stringify(r)).join(',\n') +
  '\n]\n}\n';
writeFileSync(OUT, json);
console.log(`Wrote ${fileURLToPath(OUT)} (${(json.length / 1024).toFixed(0)} KB) in ${((performance.now() - t0) / 1000).toFixed(0)}s`);

// Spot checks against direct enumeration.
for (const [x, y] of [['AA', 'KK'], ['AKs', 'QQ'], ['AKo', '22'], ['72o', 'AA'], ['T9s', 'A5o']]) {
  const direct = exactEquity([x, y]).players[0].equity;
  const table = equity[classes.indexOf(x)][classes.indexOf(y)];
  console.log(`${x} vs ${y}: table ${(table * 100).toFixed(3)}%, direct ${(direct * 100).toFixed(3)}%`);
}
