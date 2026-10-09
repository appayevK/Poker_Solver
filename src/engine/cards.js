// Card representation and parsing.
// Card = integer 0..51 (rank * 4 + suit). Ranks 2..A → 0..12, suits c d h s → 0..3.

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

/** 'As' → 51 */
export function parseCard(str) {
  // TODO
}

/** 51 → 'As' */
export function cardToString(card) {
  // TODO
}

/** 'AsKd' or 'As Kd' → [51, 46] */
export function parseCards(str) {
  // TODO
}

/** Full 52-card deck, optionally excluding dead cards. */
export function deck(dead = []) {
  // TODO
}
