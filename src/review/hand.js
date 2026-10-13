// Internal hand format shared by the GG parser and manual entry.
//
// Amounts are integers in the smallest unit: cents in $ games, chips in tournaments, so
// sums never drift. hand.unit = { currency: '$' | null, scale } converts them for display
// (formatAmount) and toBB gives big blinds.
//
// The table-state walker at the bottom (startState / applyAction / nextToAct /
// legalActions) is the one place that knows the betting rules; validateHand, the
// replayer and manual entry all use it.

import { parseCards, cardToString } from '../engine/cards.js';

export const STREETS = ['preflop', 'flop', 'turn', 'river'];
export const ACTION_TYPES = ['post', 'fold', 'check', 'call', 'bet', 'raise', 'allin'];
export const POST_TYPES = ['sb', 'bb', 'ante', 'straddle', 'dead'];
export const FORMATS = ['cash', 'mtt', 'pko'];

/**
 * @typedef {object} Player
 * @property {number} seat
 * @property {string} name
 * @property {number} stack          chips at the start of the hand (smallest unit)
 * @property {string} position       BTN, SB, BB, UTG, HJ, CO ... (computed from the button)
 * @property {number|null} bounty    PKO bounty in the bounty currency ($), as shown
 * @property {number[]|null} cards   two hole cards when known (hero, or shown at showdown)
 * @property {boolean} isHero
 *
 * @typedef {object} Action
 * @property {'preflop'|'flop'|'turn'|'river'} street
 * @property {string} player
 * @property {'post'|'fold'|'check'|'call'|'bet'|'raise'|'allin'} type
 *           ('allin' is accepted on input and resolved to bet / raise / call + isAllIn)
 * @property {number} amount         chips this action adds
 * @property {number|null} to        the player's total on this street after the action
 *                                   (the "raise to" figure; null for folds and checks)
 * @property {boolean} isAllIn
 * @property {string} [post]         for posts: sb | bb | ante | straddle | dead
 *
 * @typedef {object} Hand
 * @property {string} id
 * @property {'gg'|'manual'} site
 * @property {'cash'|'mtt'|'pko'} format
 * @property {string|null} variant   'regular', 'rushAndCash', ... (null when unknown)
 * @property {string|null} date      'YYYY-MM-DDTHH:MM:SS' as printed by the site
 * @property {string} table
 * @property {number} maxSeats
 * @property {number} button         button seat
 * @property {{currency: string|null, scale: number}} unit
 * @property {{sb:number, bb:number, ante:number, bbAnte:boolean}} blinds
 * @property {number|null} straddle
 * @property {Player[]} players      in seat order
 * @property {string|null} hero      hero's name
 * @property {Action[]} actions
 * @property {number[]} board        the (first) board, 0-5 cards
 * @property {number[][]|null} boards  both full boards when the hand was run twice
 * @property {{player:string, amount:number}[]} uncalled
 * @property {{player:string, amount:number, run?:number}[]} collected
 * @property {{player:string, cards:number[], description?:string}[]} shows
 * @property {number|null} pot       total pot from the summary (null when unknown)
 * @property {number} rake
 * @property {Object<string, number>} fees   jackpot, bingo, fortune, tax ... (taken from the pot)
 * @property {{player:string, type:string, amount:number|null}[]} cashout
 *           EV cashout events; type 'cashoutRisk' amounts are paid from the player's stack
 * @property {object|null} tournament  { id, name, buyIn, level, payouts, playersLeft }
 * @property {string[]} tags
 * @property {string} notes
 * @property {object[]} flags        filled by leak detection
 * @property {string[]} unparsed     source lines the parser did not understand
 */

const SIX_MAX_MIDDLE = ['UTG', 'HJ', 'CO'];
const FULL_RING_MIDDLE = ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'];

const isInt = (x) => Number.isInteger(x);

function fail(message) {
  throw new Error(`Invalid hand: ${message}`);
}

function toCards(input, what) {
  if (input === null || input === undefined || input === '') return null;
  try {
    return parseCards(input);
  } catch (err) {
    fail(`${what}: ${err.message}`);
  }
}

/** Players ordered clockwise starting with the seat after the button. */
function clockwise(players, button) {
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const after = sorted.filter((p) => p.seat > button);
  const before = sorted.filter((p) => p.seat <= button);
  return [...after, ...before];
}

/**
 * Position labels by seat, counted from the button: BTN, SB, BB, then UTG ... CO for
 * the players in between (CO next to the button). Heads-up the button is the SB.
 * The SB is whoever posted the small blind (so a missing SB shifts nothing).
 */
export function computePositions(players, button, actions = [], maxSeats = 9) {
  const order = clockwise(players, button);
  const n = order.length;
  const out = new Map();
  if (n === 0) return out;
  const btn = order[n - 1].seat === button ? order[n - 1] : null;
  if (n === 2) {
    const sb = btn ?? order[1];
    out.set(sb.seat, 'SB');
    out.set(order.find((p) => p !== sb).seat, 'BB');
    return out;
  }
  const posted = (kind) => actions.find((a) => a.type === 'post' && a.post === kind)?.player;
  const sbName = posted('sb');
  let i = 0;
  if (sbName && order[0].name === sbName) {
    out.set(order[0].seat, 'SB');
    i = 1;
  }
  if (i < n - (btn ? 1 : 0)) out.set(order[i].seat, 'BB');
  const middle = order.slice(i + 1, btn ? n - 1 : n);
  const names = maxSeats > 6 ? FULL_RING_MIDDLE : SIX_MAX_MIDDLE;
  // Named back from the button, so a label always means the same number of players
  // behind (5-handed 6-max: HJ, CO, BTN, SB, BB).
  const labels = middle.length <= names.length ? names.slice(names.length - middle.length) : middle.map((_, k) => `MP${k + 1}`);
  middle.forEach((p, k) => out.set(p.seat, labels[k]));
  if (btn) out.set(btn.seat, 'BTN');
  return out;
}

/**
 * Validates the structure of a hand and fills defaults. Throws on structural errors
 * (missing players, unknown action types...); consistency (chips, cards, turn order) is
 * checked by validateHand, which reports problems without throwing.
 */
export function createHand(fields = {}) {
  const unit = { currency: fields.unit?.currency ?? null, scale: fields.unit?.scale ?? 1 };
  const blinds = { sb: 0, ante: 0, bbAnte: false, ...fields.blinds };
  if (!isInt(blinds.bb) || blinds.bb <= 0) fail('the big blind must be a positive whole number of units');
  for (const k of ['sb', 'ante']) if (!isInt(blinds[k]) || blinds[k] < 0) fail(`blinds.${k} must be a whole number ≥ 0`);
  if (!Array.isArray(fields.players) || fields.players.length < 2) fail('a hand needs at least two players');
  const format = fields.format ?? 'cash';
  if (!FORMATS.includes(format)) fail(`unknown format "${format}"`);

  const seats = new Set();
  const names = new Set();
  const players = fields.players.map((p) => {
    if (!isInt(p.seat) || p.seat < 1) fail(`bad seat ${p.seat}`);
    if (!p.name) fail(`seat ${p.seat} has no name`);
    if (seats.has(p.seat)) fail(`seat ${p.seat} is used twice`);
    if (names.has(p.name)) fail(`player name "${p.name}" is used twice`);
    if (!isInt(p.stack) || p.stack < 0) fail(`${p.name}'s stack must be a whole number ≥ 0`);
    seats.add(p.seat);
    names.add(p.name);
    const cards = toCards(p.cards, `${p.name}'s cards`);
    return { seat: p.seat, name: p.name, stack: p.stack, position: p.position ?? null, bounty: p.bounty ?? null, cards, isHero: false };
  });
  players.sort((a, b) => a.seat - b.seat);
  const hero = fields.hero ?? null;
  if (hero !== null && !names.has(hero)) fail(`hero "${hero}" is not at the table`);
  for (const p of players) p.isHero = p.name === hero;
  const button = fields.button;
  if (!isInt(button) || button < 1) fail('the button seat is missing');
  const maxSeats = fields.maxSeats ?? Math.max(players.length, players[players.length - 1].seat, 6);

  const actions = (fields.actions ?? []).map((a, i) => {
    if (!STREETS.includes(a.street)) fail(`action ${i + 1}: unknown street "${a.street}"`);
    if (!ACTION_TYPES.includes(a.type)) fail(`action ${i + 1}: unknown type "${a.type}"`);
    if (!names.has(a.player)) fail(`action ${i + 1}: unknown player "${a.player}"`);
    if (a.type === 'post' && !POST_TYPES.includes(a.post)) fail(`action ${i + 1}: unknown post "${a.post}"`);
    for (const k of ['amount', 'to']) if (a[k] !== undefined && a[k] !== null && (!isInt(a[k]) || a[k] < 0)) fail(`action ${i + 1}: ${k} must be a whole number ≥ 0`);
    return { street: a.street, player: a.player, type: a.type, amount: a.amount ?? null, to: a.to ?? null, isAllIn: !!a.isAllIn, ...(a.type === 'post' ? { post: a.post } : {}) };
  });

  const positions = computePositions(players, button, actions, maxSeats);
  for (const p of players) p.position ??= positions.get(p.seat) ?? null;

  const board = toCards(fields.board, 'board') ?? [];
  if (board.length > 5) fail('the board has more than 5 cards');
  const boards = fields.boards ? fields.boards.map((b, i) => toCards(b, `board ${i + 1}`) ?? []) : null;

  const hand = {
    id: fields.id ?? `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    site: fields.site ?? 'manual',
    format,
    variant: fields.variant ?? null,
    date: fields.date ?? null,
    table: fields.table ?? '',
    maxSeats,
    button,
    unit,
    blinds,
    straddle: fields.straddle ?? null,
    players,
    hero,
    actions,
    board,
    boards,
    uncalled: (fields.uncalled ?? []).map((u) => ({ player: u.player, amount: u.amount })),
    collected: (fields.collected ?? []).map((c) => ({ player: c.player, amount: c.amount, ...(c.run ? { run: c.run } : {}) })),
    shows: (fields.shows ?? []).map((s) => ({ player: s.player, cards: toCards(s.cards, `${s.player}'s shown cards`) ?? [], ...(s.description ? { description: s.description } : {}) })),
    pot: fields.pot ?? null,
    rake: fields.rake ?? 0,
    fees: { ...fields.fees },
    cashout: (fields.cashout ?? []).map((c) => ({ player: c.player, type: c.type, amount: c.amount ?? null })),
    tournament: fields.tournament ?? null,
    tags: [...(fields.tags ?? [])],
    notes: fields.notes ?? '',
    flags: [...(fields.flags ?? [])],
    unparsed: [...(fields.unparsed ?? [])],
  };
  resolveAmounts(hand);
  return hand;
}

/**
 * Fills in amount / to for actions that give only one of them, resolves 'allin' into
 * bet / raise / call, and sets isAllIn when the stack runs out.
 */
function resolveAmounts(hand) {
  let state = startState(hand);
  for (const a of hand.actions) {
    if (a.street !== state.street && STREETS.indexOf(a.street) > STREETS.indexOf(state.street)) state = nextStreet(state, a.street, hand);
    const p = state.players.find((x) => x.name === a.player);
    if (!p) continue;
    if (a.type === 'allin') {
      a.amount = p.stack;
      a.to = p.inStreet + p.stack;
      a.type = state.bet === 0 ? 'bet' : a.to > state.bet ? 'raise' : 'call';
    } else if (a.type === 'call') {
      a.amount ??= a.to !== null ? a.to - p.inStreet : Math.min(state.bet - p.inStreet, p.stack);
      a.to = p.inStreet + a.amount;
    } else if (a.type === 'bet' || a.type === 'raise') {
      if (a.amount === null && a.to !== null) a.amount = a.to - p.inStreet;
      if (a.to === null && a.amount !== null) a.to = p.inStreet + a.amount;
    } else if (a.type === 'post') {
      a.amount ??= a.post === 'sb' ? hand.blinds.sb : a.post === 'bb' ? hand.blinds.bb : a.post === 'ante' ? hand.blinds.ante : 0;
    } else {
      a.amount = 0;
      a.to = null;
    }
    if (a.type !== 'fold' && a.type !== 'check' && a.amount !== null && a.amount >= p.stack && p.stack > 0) a.isAllIn = true;
    state = applyAction(state, a, hand).state;
  }
}

// ---------------------------------------------------------------------------
// Helpers

/** Amount in big blinds. */
export function toBB(amount, hand) {
  return amount / hand.blinds.bb;
}

/** Amount for display: '$0.25' in $ games, '1,200' in chips. */
export function formatAmount(amount, hand) {
  const { currency, scale } = hand.unit;
  const value = amount / scale;
  if (currency) return `${currency}${value.toFixed(scale >= 100 ? 2 : 0).replace(/\.00$/, '')}`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Hero's seat number, or null when the hand has no hero. */
export function heroSeat(hand) {
  return hand.players.find((p) => p.isHero)?.seat ?? null;
}

export function heroPlayer(hand) {
  return hand.players.find((p) => p.isHero) ?? null;
}

/**
 * Final chips per player: start - put in + uncalled returned + collected - cashout risk
 * paid. Returns Map(name → { start, invested, collected, end, net }).
 */
export function results(hand) {
  const out = new Map(hand.players.map((p) => [p.name, { start: p.stack, invested: 0, collected: 0, end: p.stack, net: 0 }]));
  for (const a of hand.actions) if (a.amount) out.get(a.player).invested += a.amount;
  for (const u of hand.uncalled) out.get(u.player).invested -= u.amount;
  for (const c of hand.collected) out.get(c.player).collected += c.amount;
  const risk = new Map();
  for (const c of hand.cashout) if (c.type === 'cashoutRisk' && c.amount) risk.set(c.player, (risk.get(c.player) ?? 0) + c.amount);
  for (const [name, r] of out) {
    r.net = r.collected - r.invested - (risk.get(name) ?? 0);
    r.end = r.start + r.net;
  }
  return out;
}

/** Hero's net result in big blinds (0 when there is no hero). */
export function heroResultBB(hand) {
  if (!hand.hero) return 0;
  return toBB(results(hand).get(hand.hero).net, hand);
}

// ---------------------------------------------------------------------------
// Table-state walker

/** State before the first action: players clockwise from the seat after the button. */
export function startState(hand) {
  const order = clockwise(hand.players, hand.button);
  return {
    street: 'preflop',
    players: order.map((p) => ({ name: p.name, seat: p.seat, stack: p.stack, inStreet: 0, total: 0, folded: false, allIn: p.stack === 0, acted: false })),
    pot: 0,
    bet: 0,
    minRaise: hand.blinds.bb,
    last: order.length - 1,
    bbPosted: false,
  };
}

function cloneState(s) {
  return { ...s, players: s.players.map((p) => ({ ...p })) };
}

/** Moves the state to a later street: street bets reset, action starts left of the button. */
export function nextStreet(state, street, hand) {
  const s = cloneState(state);
  s.street = street;
  s.bet = 0;
  s.minRaise = hand.blinds.bb;
  s.last = s.players.length - 1;
  for (const p of s.players) {
    p.inStreet = 0;
    p.acted = false;
  }
  return s;
}

/** Index (into state.players) of the player to act next, or -1 when the round is over. */
export function nextToAct(state) {
  const live = state.players.filter((p) => !p.folded);
  if (live.length <= 1) return -1;
  const canAct = live.filter((p) => !p.allIn);
  // Everyone else is all-in and the last player with chips has matched: no betting left.
  if (canAct.length === 0 || (canAct.length === 1 && canAct[0].inStreet >= state.bet)) return -1;
  const n = state.players.length;
  const needs = (p) => !p.folded && !p.allIn && (!p.acted || p.inStreet < state.bet);
  for (let k = 1; k <= n; k++) {
    const i = (state.last + k) % n;
    if (needs(state.players[i])) return i;
  }
  return -1;
}

/** True when the betting on this street is finished (or the hand is over). */
export function roundOver(state) {
  return nextToAct(state) === -1;
}

/**
 * The options of the player to act: { player, index, toCall, options: [...], callAmount,
 * minTo, maxTo }, or null when nobody is to act. options ⊆ fold, check, call, bet, raise.
 * Bets and raises are given as "to" totals for the street; all-in is maxTo.
 */
export function legalActions(state, hand) {
  const i = nextToAct(state);
  if (i < 0) return null;
  const p = state.players[i];
  const toCall = Math.max(0, state.bet - p.inStreet);
  const options = [];
  if (toCall > 0) options.push('fold', 'call');
  else options.push('check');
  const othersCanAct = state.players.some((q) => q !== p && !q.folded && !q.allIn);
  const maxTo = p.inStreet + p.stack;
  if (state.bet === 0 && p.stack > 0) options.push('bet');
  else if (p.stack > toCall && othersCanAct) options.push('raise');
  const minTo = state.bet === 0 ? Math.min(hand.blinds.bb, maxTo) : Math.min(state.bet + state.minRaise, maxTo);
  return { player: p.name, index: i, toCall, callAmount: Math.min(toCall, p.stack), options, minTo, maxTo };
}

/**
 * Applies one action. Returns { state, problems } with a new state (the input is not
 * changed) and any rule problems found (acting out of turn, checking facing a bet,
 * wrong call amount, raise below the minimum, more chips than the stack...).
 */
export function applyAction(state, action, hand) {
  const s = cloneState(state);
  const problems = [];
  const idx = s.players.findIndex((p) => p.name === action.player);
  if (idx < 0) return { state: s, problems: [`${action.player} is not in the hand`] };
  const p = s.players[idx];
  const say = (msg) => problems.push(`${action.player} ${msg} (${action.street})`);

  if (action.type === 'post') {
    const amt = Math.min(action.amount ?? 0, p.stack);
    if ((action.amount ?? 0) > p.stack) say(`posts more than their stack`);
    p.stack -= amt;
    p.total += amt;
    s.pot += amt;
    if (action.post !== 'ante' && action.post !== 'dead') {
      p.inStreet += amt;
      s.bet = Math.max(s.bet, p.inStreet);
      if (action.post === 'straddle') {
        s.last = idx;
        s.minRaise = Math.max(s.minRaise, amt);
      } else if (action.post === 'bb' && !s.bbPosted) {
        s.last = idx;
        s.bbPosted = true;
      } else if (action.post === 'sb' && !s.bbPosted) s.last = idx;
    }
    if (p.stack === 0) p.allIn = true;
    return { state: s, problems };
  }

  const expected = nextToAct(s);
  if (expected !== idx) say(expected < 0 ? 'acts after the betting was closed' : `acts out of turn (${s.players[expected].name} was to act)`);
  if (p.folded) say('acts after folding');
  if (p.allIn) say('acts after going all-in');
  const toCall = Math.max(0, s.bet - p.inStreet);
  let amt = 0;
  switch (action.type) {
    case 'fold':
      p.folded = true;
      break;
    case 'check':
      if (toCall > 0) say('checks facing a bet');
      break;
    case 'call':
      amt = action.amount ?? Math.min(toCall, p.stack);
      if (toCall === 0) say('calls with nothing to call');
      else if (amt !== Math.min(toCall, p.stack)) say(`calls ${amt} but ${Math.min(toCall, p.stack)} was owed`);
      break;
    case 'bet':
      amt = action.amount ?? 0;
      if (s.bet > 0) say('bets when there is already a bet (should be a raise)');
      if (amt <= 0) say('bets nothing');
      if (amt < Math.min(hand.blinds.bb, p.stack) && amt < p.stack) say('bets less than the big blind');
      s.minRaise = Math.max(hand.blinds.bb, amt);
      s.bet = p.inStreet + amt;
      for (const q of s.players) if (q !== p) q.acted = false;
      break;
    case 'raise': {
      amt = action.amount ?? (action.to ?? 0) - p.inStreet;
      const to = p.inStreet + amt;
      if (s.bet === 0) say('raises with no bet to raise');
      if (to <= s.bet) say(`raises to ${to}, not above the bet of ${s.bet}`);
      const increment = to - s.bet;
      const allIn = amt >= p.stack;
      if (increment < s.minRaise && !allIn) say(`raises by ${increment}, less than the minimum ${s.minRaise}`);
      if (increment >= s.minRaise) {
        s.minRaise = increment;
        for (const q of s.players) if (q !== p) q.acted = false;
      }
      s.bet = Math.max(s.bet, to);
      break;
    }
    default:
      say(`has an unknown action "${action.type}"`);
  }
  if (amt > p.stack) {
    say(`puts in ${amt}, more than their stack of ${p.stack}`);
    amt = p.stack;
  }
  p.stack -= amt;
  p.inStreet += amt;
  p.total += amt;
  s.pot += amt;
  p.acted = true;
  if (p.stack === 0 && action.type !== 'fold') p.allIn = true;
  if (action.isAllIn && p.stack !== 0) say('is marked all-in but has chips left');
  s.last = idx;
  return { state: s, problems };
}

/** Every known card (hole cards, shown cards, boards) with where it came from. */
function knownCards(hand) {
  const seen = [];
  for (const p of hand.players) if (p.cards) for (const c of p.cards) seen.push([c, `${p.name}'s cards`]);
  for (const s of hand.shows) {
    const own = hand.players.find((p) => p.name === s.player)?.cards ?? [];
    for (const c of s.cards) if (!own.includes(c)) seen.push([c, `${s.player}'s shown cards`]);
  }
  const boards = hand.boards ?? [hand.board];
  boards.forEach((b, i) => {
    const shared = i === 0 ? [] : boards[0];
    for (let k = 0; k < b.length; k++) if (i === 0 || b[k] !== shared[k]) seen.push([b[k], i === 0 ? 'the board' : `board ${i + 1}`]);
  });
  return seen;
}

/**
 * Consistency checks. Returns a list of problems ({ code, message }); an empty list
 * means the hand is consistent. Never throws, so an odd hand can still be reviewed.
 *   cards   no card appears twice
 *   order   actions follow the betting rules and turn order, streets in order
 *   chips   contributions - uncalled = pot; pot = collected + rake + fees
 */
export function validateHand(hand) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });

  const where = new Map();
  for (const [card, from] of knownCards(hand)) {
    if (where.has(card)) add('cards', `${cardToString(card)} appears in ${where.get(card)} and ${from}`);
    else where.set(card, from);
  }

  let state = startState(hand);
  let streetIndex = 0;
  hand.actions.forEach((a) => {
    const k = STREETS.indexOf(a.street);
    if (k < streetIndex) add('order', `${a.player}'s ${a.type} on the ${a.street} comes after a later street`);
    if (k > streetIndex) {
      if (!roundOver(state)) add('order', `the ${a.street} starts before the ${state.street} betting was finished`);
      streetIndex = k;
      state = nextStreet(state, a.street, hand);
    }
    if (a.type === 'post' && k > 0) add('order', `${a.player} posts on the ${a.street}`);
    const r = applyAction(state, a, hand);
    for (const m of r.problems) add('order', m);
    state = r.state;
  });
  const needed = { flop: 3, turn: 4, river: 5 }[STREETS[streetIndex]] ?? 0;
  if (hand.board.length < needed) add('cards', `there is action on the ${STREETS[streetIndex]} but the board has ${hand.board.length} cards`);

  const invested = state.players.reduce((sum, p) => sum + p.total, 0);
  const returned = hand.uncalled.reduce((sum, u) => sum + u.amount, 0);
  for (const u of hand.uncalled) {
    const p = state.players.find((x) => x.name === u.player);
    if (!p) add('chips', `uncalled bet returned to unknown player ${u.player}`);
    else {
      // Only the part of a bet nobody matched can come back.
      const excess = p.total - Math.max(0, ...state.players.filter((x) => x !== p).map((x) => x.total));
      if (u.amount > excess) add('chips', `${u.player} gets back ${u.amount}, more than the ${excess} nobody matched`);
    }
  }
  const pot = invested - returned;
  if (hand.pot !== null && hand.pot !== undefined && hand.pot !== pot) add('chips', `the pot is ${hand.pot} but the players put in ${pot}`);
  if (hand.collected.length) {
    const paid = hand.collected.reduce((sum, c) => sum + c.amount, 0);
    const fees = Object.values(hand.fees).reduce((sum, x) => sum + (x ?? 0), 0);
    const total = hand.pot ?? pot;
    if (paid + hand.rake + fees !== total) add('chips', `collected ${paid} + rake ${hand.rake} + fees ${fees} does not equal the pot of ${total}`);
  }
  for (const [name, r] of results(hand)) if (r.end < 0) add('chips', `${name} ends the hand with a negative stack`);
  return problems;
}
