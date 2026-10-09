// Automatic leak detection on reviewed hands.

/** Returns a list of flags, e.g. { type: 'oversizedJam', street, message }. */
export function detectLeaks(hand, states) {
  // TODO:
  // - jam size vs effective stack (oversized jams over short stacks)
  // - calls below required equity
  // - large deviations from Nash in push/fold spots
}
