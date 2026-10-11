// Suit-isomorphic canonical flops.
//
// Two flops are strategically identical when a relabelling of suits maps one onto
// the other. The canonical form is the image under the suit permutation that makes
// the cards, sorted from high to low, as large as possible: spades first, then
// hearts, diamonds, clubs. So A-K-2 rainbow is AsKh2d, a two-tone K-9-4 with the 9
// and 4 suited is Ks9h4h, and a monotone board is all spades. There are 1755
// canonical flops; the 22,100 raw flops map onto them.

import { parseCards, cardsToString } from '../engine/cards.js';

/** All 24 permutations of the suits 0..3 (perm[realSuit] = newSuit). */
export const SUIT_PERMS = (() => {
  const out = [];
  const rec = (prefix, rest) => {
    if (!rest.length) out.push(prefix);
    rest.forEach((s, i) => rec([...prefix, s], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  rec([], [0, 1, 2, 3]);
  return out;
})();

/** Maps a card through a suit permutation. */
export const mapCard = (card, perm) => (card & ~3) | perm[card & 3];

/** Inverse of a suit permutation. */
export function invertPerm(perm) {
  const inv = [0, 0, 0, 0];
  perm.forEach((to, from) => {
    inv[to] = from;
  });
  return inv;
}

const desc = (a, b) => b - a;

/**
 * Canonical form of a flop (card indices or a string like 'QsJh2h').
 * Returns { cards, key, perm, inverse }: cards sorted high to low in canonical suits,
 * key = their string ('QsJh2h'), perm[realSuit] = canonical suit and its inverse.
 */
export function canonicalFlop(input) {
  const cards = typeof input === 'string' || Array.isArray(input) ? parseCards(input) : input;
  if (cards.length !== 3) throw new Error('A flop has exactly 3 cards');
  let best = null;
  let bestPerm = null;
  for (const perm of SUIT_PERMS) {
    const mapped = cards.map((c) => mapCard(c, perm)).sort(desc);
    if (!best || mapped[0] > best[0] || (mapped[0] === best[0] && (mapped[1] > best[1] || (mapped[1] === best[1] && mapped[2] > best[2])))) {
      best = mapped;
      bestPerm = perm;
    }
  }
  return { cards: best, key: cardsToString(best), perm: bestPerm.slice(), inverse: invertPerm(bestPerm) };
}

let all = null;

/**
 * Every canonical flop with the number of raw flops it stands for:
 * [{ key, cards, raw }] sorted by key; raw counts sum to 22,100.
 */
export function allCanonicalFlops() {
  if (all) return all;
  const byKey = new Map();
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      for (let c = b + 1; c < 52; c++) {
        const { key, cards } = canonicalFlop([a, b, c]);
        const entry = byKey.get(key);
        if (entry) entry.raw++;
        else byKey.set(key, { key, cards, raw: 1 });
      }
    }
  }
  all = [...byKey.values()].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return all;
}
