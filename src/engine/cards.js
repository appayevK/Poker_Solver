// Card representation and parsing.
// Card = integer 0..51 (rank * 4 + suit). Ranks 2..A → 0..12, suits c d h s → 0..3.

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

const CARD_RE = /(10|[2-9tjqka])([cdhs])/iy;

function rankIndex(ch) {
  return RANKS.indexOf(ch === '10' ? 'T' : ch.toUpperCase());
}

/** 'As' → 51 */
export function parseCard(str) {
  if (typeof str !== 'string') throw new TypeError(`Card must be a string, got ${typeof str}`);
  const s = str.trim();
  const m = /^(10|.)(.)$/.exec(s);
  if (!m) throw new Error(`Invalid card "${str}": expected rank + suit, e.g. "As"`);
  const rank = rankIndex(m[1]);
  if (rank < 0) throw new Error(`Invalid card "${str}": bad rank "${m[1]}" (use ${RANKS})`);
  const suit = SUITS.indexOf(m[2].toLowerCase());
  if (suit < 0) throw new Error(`Invalid card "${str}": bad suit "${m[2]}" (use ${SUITS})`);
  return rank * 4 + suit;
}

/** 51 → 'As' */
export function cardToString(card) {
  if (!Number.isInteger(card) || card < 0 || card > 51) throw new Error(`Invalid card index ${card}`);
  return RANKS[card >> 2] + SUITS[card & 3];
}

/** [51, 45] → 'AsKd' */
export function cardsToString(cards, sep = '') {
  return cards.map(cardToString).join(sep);
}

/**
 * 'AsKd' or 'As Kd' → [51, 45]. Commas and whitespace between cards are ignored.
 * Also accepts an array of card indices or card strings (validated and copied).
 * Throws on invalid cards and duplicates.
 */
export function parseCards(input) {
  let cards;
  if (Array.isArray(input)) {
    cards = input.map((c) => (typeof c === 'string' ? parseCard(c) : (cardToString(c), c)));
  } else if (typeof input === 'string') {
    cards = [];
    const s = input.replace(/[\s,]+/g, '');
    CARD_RE.lastIndex = 0;
    while (CARD_RE.lastIndex < s.length) {
      const at = CARD_RE.lastIndex;
      const m = CARD_RE.exec(s);
      if (!m) throw new Error(`Invalid cards "${input}": cannot parse "${s.slice(at, at + 2)}"`);
      cards.push(parseCard(m[0]));
    }
  } else if (input == null) {
    cards = [];
  } else {
    throw new TypeError(`Cannot parse cards from ${typeof input}`);
  }
  const seen = new Set();
  for (const c of cards) {
    if (seen.has(c)) throw new Error(`Duplicate card ${cardToString(c)}`);
    seen.add(c);
  }
  return cards;
}

/** Full 52-card deck, optionally excluding dead cards (array of indices or a card string). */
export function deck(dead = []) {
  const blocked = new Set(typeof dead === 'string' ? parseCards(dead) : dead);
  const out = [];
  for (let c = 0; c < 52; c++) if (!blocked.has(c)) out.push(c);
  return out;
}
