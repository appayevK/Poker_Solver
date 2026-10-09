// Range parsing and representation.
// A range is a Map of 169 hand classes ('AKs', 'QQ', 'T9o') → weight 0..1.

/** All 169 hand classes in grid order (row = first rank, col = second rank). */
export function handClasses() {
  // TODO
}

/** '22+, A2s+, KTo+, 76s:0.5' → Map */
export function parseRange(str) {
  // TODO
}

/** Map → compact notation string. */
export function rangeToString(range) {
  // TODO
}

/** Percentage of all 1326 combos the range covers. */
export function rangePercent(range) {
  // TODO
}
