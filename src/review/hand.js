// Internal hand format shared by the GG parser and manual entry.

/**
 * @typedef {object} Hand
 * @property {string} id
 * @property {'cash'|'mtt'|'pko'} format
 * @property {{sb:number, bb:number, ante:number}} blinds
 * @property {{seat:number, name:string, stack:number, bounty?:number, cards?:number[]}[]} players
 * @property {string} hero
 * @property {{street:'preflop'|'flop'|'turn'|'river', player:string, action:string, amount?:number}[]} actions
 * @property {number[]} board
 * @property {{payouts?:number[]}} [tournament]
 * @property {string[]} tags
 * @property {string} notes
 */

export function createHand(fields) {
  // TODO: validate and fill defaults
}
