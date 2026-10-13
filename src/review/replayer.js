// Street-by-street replayer with per-decision analysis.
//
// buildStates(hand) walks the actions with the table-state rules in hand.js and returns
// one state per action (posts excluded): what the player faced (pot, stacks, amount to
// call, effective stack, SPR, pot odds) and the table after the action, including side
// pots. analyseDecision(state, ...) turns a hero decision into numbers using calc/ev.js,
// calc/icm.js, calc/pko.js and the Nash push/fold solver. Everything returned is plain
// data; the Review tab decides how to show it.

import { startState, nextStreet, applyAction, results, heroPlayer, STREETS } from './hand.js';
import { requiredEquity, callEV, betEV, breakEvenFoldFreq, mdf } from '../calc/ev.js';
import { icmRequiredEquity, chipRequiredEquity, riskPremium, spotEV } from '../calc/icm.js';
import { nashAction } from '../nash/pushfold.js';
import { runEquity } from '../workers/client.js';
import { solveNash } from '../workers/nash-client.js';
import { comboClass } from '../engine/ranges.js';

const BOARD_CARDS = { preflop: 0, flop: 3, turn: 4, river: 5 };
/** Effective stacks at or below this many big blinds count as push/fold spots. */
export const PUSH_FOLD_BB = 20;

/**
 * Side pots from contributions: [{ amount, eligible: [names] }], main pot first.
 * players: [{ name, total, folded, allIn }]. A top "pot" with one eligible player is an
 * unmatched bet that will be returned.
 */
export function sidePots(players) {
  const levels = [...new Set(players.filter((p) => !p.folded && p.allIn).map((p) => p.total))].sort((a, b) => a - b);
  const cap = Math.max(0, ...players.map((p) => p.total));
  const pots = [];
  let prev = 0;
  for (const level of [...levels, cap]) {
    if (level <= prev) continue;
    let amount = 0;
    for (const p of players) amount += Math.max(0, Math.min(p.total, level) - prev);
    const eligible = players.filter((p) => !p.folded && p.total >= level).map((p) => p.name);
    const same = pots[pots.length - 1];
    if (same && same.eligible.join() === eligible.join()) same.amount += amount;
    else if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

function snapshot(state, hand) {
  const pos = new Map(hand.players.map((p) => [p.name, p.position]));
  return state.players.map((p) => ({ name: p.name, seat: p.seat, position: pos.get(p.name), stack: p.stack, inStreet: p.inStreet, total: p.total, folded: p.folded, allIn: p.allIn }));
}

/** The last bet or raise on this street before action i: { player, potBefore, bet, to }. */
function lastAggression(hand, i, states) {
  for (let k = i - 1; k >= 0; k--) {
    const a = hand.actions[k];
    if (a.street !== hand.actions[i].street) break;
    if (a.type === 'bet' || a.type === 'raise') return { player: a.player, potBefore: states[k].pot, bet: a.amount, to: a.to };
  }
  return null;
}

/**
 * One state per action (posts excluded):
 * { actionIndex, street, board, actor, isHero, action, pot, toCall, callAmount, stack,
 *   effectiveStack, spr, potOdds, facing, table, potAfter, pots }
 * pot / stack / toCall are before the action; table, potAfter and pots after it.
 * Amounts are in the hand's units (hand.unit); use toBB for big blinds.
 */
export function buildStates(hand) {
  let state = startState(hand);
  const befores = [];
  const states = [];
  hand.actions.forEach((a, actionIndex) => {
    if (a.street !== state.street && STREETS.indexOf(a.street) > STREETS.indexOf(state.street)) state = nextStreet(state, a.street, hand);
    const before = state;
    const after = applyAction(state, a, hand).state;
    befores[actionIndex] = { pot: before.pot };
    if (a.type !== 'post') {
      const me = before.players.find((p) => p.name === a.player);
      const toCall = Math.max(0, before.bet - me.inStreet);
      const opponents = before.players.filter((p) => p !== me && !p.folded);
      const most = Math.max(0, ...opponents.map((p) => p.stack + Math.max(0, p.inStreet - me.inStreet)));
      const effectiveStack = Math.min(me.stack, most);
      const callAmount = Math.min(toCall, me.stack);
      states.push({
        actionIndex,
        street: a.street,
        board: hand.board.slice(0, BOARD_CARDS[a.street]),
        actor: a.player,
        isHero: a.player === hand.hero,
        action: a,
        pot: before.pot,
        toCall,
        callAmount,
        stack: me.stack,
        effectiveStack,
        spr: before.pot > 0 ? effectiveStack / before.pot : null,
        potOdds: callAmount > 0 ? callAmount / (before.pot + callAmount) : null,
        facing: toCall > 0 ? lastAggression(hand, actionIndex, befores) : null,
        live: opponents.map((p) => p.name),
        table: snapshot(after, hand),
        potAfter: after.pot,
        pots: sidePots(after.players),
      });
    }
    state = after;
  });
  return states;
}

/** The table once blinds and antes are posted, before the first action: { table, pot }. */
export function postedState(hand) {
  let state = startState(hand);
  for (const a of hand.actions) {
    if (a.type !== 'post' || a.street !== 'preflop') break;
    state = applyAction(state, a, hand).state;
  }
  return { table: snapshot(state, hand), pot: state.pot };
}

/** Stacks and pot when the hand is over (after uncalled bets are returned and pots paid). */
export function finalState(hand) {
  const r = results(hand);
  return hand.players.map((p) => ({ name: p.name, seat: p.seat, position: p.position, start: p.stack, end: r.get(p.name).end, net: r.get(p.name).net }));
}

/** The opponent hero is most likely up against at this state. */
export function mainVillain(hand, state) {
  if (state.facing) return state.facing.player;
  const live = state.live;
  if (live.length === 1) return live[0];
  // Last aggressor among the live opponents, else the first one left.
  for (let k = state.actionIndex - 1; k >= 0; k--) {
    const a = hand.actions[k];
    if ((a.type === 'bet' || a.type === 'raise') && live.includes(a.player)) return a.player;
  }
  return live[0] ?? null;
}

function voluntaryBefore(hand, i) {
  return hand.actions.slice(0, i).filter((a) => a.street === 'preflop' && a.type !== 'post' && a.type !== 'fold');
}

/**
 * A preflop push/fold spot for hero at this state, or null:
 * { open: true } when folded to hero, { jammer } when facing one all-in with no other
 * voluntary action, plus the seats from the first actor to the BB in action order.
 */
export function pushFoldSpot(hand, state) {
  if (state.street !== 'preflop' || !state.isHero) return null;
  if (state.effectiveStack / hand.blinds.bb > PUSH_FOLD_BB) return null;
  const vol = voluntaryBefore(hand, state.actionIndex);
  let jammer = null;
  if (vol.length === 1 && vol[0].isAllIn && (vol[0].type === 'raise' || vol[0].type === 'bet')) jammer = vol[0].player;
  else if (vol.length > 0) return null;
  // Seats in preflop action order, starting with the first player after the BB.
  const order = startState(hand).players.map((p) => p.name);
  const bbIndex = order.findIndex((n) => hand.players.find((p) => p.name === n)?.position === 'BB');
  const actionOrder = bbIndex < 0 ? order : [...order.slice(bbIndex + 1), ...order.slice(0, bbIndex + 1)];
  const first = jammer ?? hand.hero;
  const seats = actionOrder.slice(actionOrder.indexOf(first));
  if (!seats.includes(hand.hero) || seats.length < 2) return null;
  return { open: !jammer, jammer, seats };
}

function nashParams(hand, spot) {
  const bb = hand.blinds.bb;
  const stacks = spot.seats.map((n) => hand.players.find((p) => p.name === n).stack / bb);
  const blinds = { sb: hand.blinds.sb / bb, bb: 1, ante: hand.blinds.ante / bb, bbAnte: hand.blinds.bbAnte };
  const payouts = hand.tournament?.payouts;
  const others = hand.players.filter((p) => !spot.seats.includes(p.name)).map((p) => p.stack / bb);
  if (hand.format === 'pko' && hand.players.every((p) => p.bounty !== null)) {
    const bounties = spot.seats.map((n) => hand.players.find((p) => p.name === n).bounty);
    if (payouts) return { params: { stacks, blinds, mode: 'pko', payouts, bounties, otherStacks: others }, mode: 'pko' };
    const start = hand.tournament?.startingStack;
    const startBounty = hand.tournament?.startingBounty;
    if (start && startBounty) return { params: { stacks, blinds, mode: 'pko', bounties, startingBounty: startBounty, startingStack: start / bb }, mode: 'pko' };
  }
  if (hand.format !== 'cash' && payouts) return { params: { stacks, blinds, mode: 'icm', payouts, otherStacks: others }, mode: 'icm' };
  return { params: { stacks, blinds, mode: 'chipEV' }, mode: 'chipEV' };
}

const heroCardsOf = (hand) => heroPlayer(hand)?.cards ?? null;

/**
 * Numbers for one hero decision. options:
 *   hand          the Hand (required)
 *   villain       opponent name (default mainVillain)
 *   villainRange  range string or Map for the equity (no equity without it)
 *   foldFreq      for hero bets and raises: how often villain folds (0-1, default 0.4)
 *   equityFn      equity backend (default runEquity), nashFn (default solveNash)
 * Returns { actionIndex, street, kind, villain, pot, toCall, equity, requiredEquity,
 *   callEV, mdf, breakEvenFoldFreq, betEV, foldFreq, icm, nash, notes } with EVs in bb
 *   (relative to folding) and fields that do not apply set to null.
 */
export async function analyseDecision(state, { hand, villain, villainRange, foldFreq = 0.4, equityFn = runEquity, nashFn = solveNash } = {}) {
  if (!hand) throw new Error('analyseDecision needs the hand');
  const bb = hand.blinds.bb;
  const a = state.action;
  // Preflop with only blinds (and limps) in: an open or iso-raise, not a call decision.
  const open = state.street === 'preflop' && !state.facing;
  const kind = open ? 'open' : state.toCall > 0 ? 'facingBet' : a.type === 'bet' || a.type === 'raise' ? 'betting' : 'checkedTo';
  const out = {
    actionIndex: state.actionIndex,
    street: state.street,
    kind,
    heroAction: a.type,
    villain: villain !== undefined ? villain : open ? null : mainVillain(hand, state),
    pot: state.pot / bb,
    toCall: state.callAmount / bb,
    effectiveStack: state.effectiveStack / bb,
    spr: state.spr,
    equity: null,
    requiredEquity: null,
    callEV: null,
    mdf: null,
    breakEvenFoldFreq: null,
    betEV: null,
    foldFreq: null,
    icm: null,
    nash: null,
    notes: [],
  };
  const heroCards = heroCardsOf(hand);
  if (!heroCards) {
    out.notes.push("Hero's cards are unknown, so there is no equity.");
  } else if (villainRange && out.villain) {
    // Cards known to belong to other players are dead for this matchup.
    const dead = hand.players.filter((p) => p.cards && !p.isHero && p.name !== out.villain).flatMap((p) => p.cards);
    try {
      // Fixed seed: a Monte Carlo result does not change each time the hand is opened.
      const res = await equityFn({ method: 'auto', players: [heroCards, villainRange], board: state.board, dead, iterations: 100000, seed: 7 });
      out.equity = res.players[0].equity;
      if (res.stdError) out.notes.push(`Monte Carlo equity, ±${(res.stdError * 100).toFixed(1)} points.`);
    } catch (err) {
      out.notes.push(`Equity failed: ${err.message}`);
    }
    if (state.live.length > 1) out.notes.push(`Multiway pot: equity is against ${out.villain}'s range only.`);
  } else if (open) out.notes.push('An open: pick a player behind and a range to see equity when called.');
  else out.notes.push('Give the villain a range to get equity.');

  if (state.toCall > 0 && !open) {
    out.requiredEquity = requiredEquity(state.pot, state.callAmount);
    if (out.equity !== null) out.callEV = callEV({ pot: state.pot, toCall: state.callAmount, equity: out.equity }) / bb;
    if (state.facing) out.mdf = mdf(state.facing.potBefore, state.facing.bet);
  }
  if (a.type === 'bet' || a.type === 'raise') {
    out.foldFreq = foldFreq;
    out.breakEvenFoldFreq = breakEvenFoldFreq(state.pot, a.amount);
    if (out.equity !== null) {
      if (a.type === 'bet') out.betEV = betEV({ pot: state.pot, bet: a.amount, foldFreq, equityWhenCalled: out.equity }) / bb;
      else {
        // Raise: villain calls the rest of hero's raise (capped by villain's stack).
        const v = state.table.find((p) => p.name === out.villain);
        const villainCall = v ? Math.min(Math.max(0, a.to - v.inStreet), v.stack) : a.amount;
        const called = out.equity * (state.pot + a.amount + villainCall) - a.amount;
        out.betEV = (foldFreq * state.pot + (1 - foldFreq) * called) / bb;
      }
    }
  }

  // Tournament all-ins: ICM (and PKO) required equity with the hand's stacks and payouts.
  const facingAllIn = !!state.facing && !!state.table.find((p) => p.name === state.facing.player)?.allIn;
  const allInDecision = a.isAllIn || facingAllIn || (state.toCall > 0 && state.callAmount >= state.stack);
  if (hand.format !== 'cash' && allInDecision && state.live.length === 1) {
    const payouts = hand.tournament?.payouts;
    if (!payouts) out.notes.push('Add the tournament payouts to get ICM numbers.');
    else {
      const seats = hand.players.map((p) => p.name);
      const before = state.table.map((p) => p.name === state.actor ? { ...p, total: p.total - (a.amount ?? 0) } : p);
      const spot = {
        stacks: hand.players.map((p) => p.stack),
        payouts,
        blinds: { sb: 0, bb: 0, ante: 0 },
        posted: seats.map((n) => before.find((p) => p.name === n)?.total ?? 0),
        hero: seats.indexOf(hand.hero),
        villain: seats.indexOf(out.villain),
        action: state.toCall > 0 ? 'call' : 'jam',
        equity: out.equity ?? 0.5,
        foldFreq: state.toCall > 0 ? 0 : foldFreq,
        ...(hand.format === 'pko' && hand.players.every((p) => p.bounty !== null) ? { bounties: hand.players.map((p) => p.bounty), pko: true } : {}),
      };
      try {
        out.icm = {
          requiredEquity: icmRequiredEquity(spot),
          chipRequiredEquity: chipRequiredEquity(spot),
          riskPremium: riskPremium(spot),
          ev: out.equity !== null ? spotEV(spot) : null,
          pko: !!spot.pko,
        };
      } catch (err) {
        out.notes.push(`ICM failed: ${err.message}`);
      }
    }
  }

  // Preflop push/fold spots: the Nash action and how much hero's action gains or loses.
  const pf = pushFoldSpot(hand, state);
  if (pf && heroCards) {
    const { params, mode } = nashParams(hand, pf);
    try {
      const solution = await nashFn({ method: 'table', ...params });
      const seat = pf.seats.indexOf(hand.hero);
      const na = nashAction(solution, { seat, node: pf.open ? 'open' : pf.seats.indexOf(pf.jammer), handClass: comboClass(heroCards[0], heroCards[1]) });
      const aggressive = pf.open ? a.isAllIn && (a.type === 'raise' || a.type === 'bet') : a.type === 'call' || a.isAllIn;
      const heroNash = a.type === 'fold' ? 'fold' : aggressive ? (pf.open ? 'jam' : 'call') : 'other';
      const evLoss = heroNash === 'fold' ? Math.max(0, na.evGap) : heroNash === 'other' ? null : Math.max(0, -na.evGap);
      out.nash = { ...na, mode, heroAction: heroNash, evLoss, open: pf.open, jammer: pf.jammer };
      if (heroNash === 'other') out.notes.push('Push/fold depth, but hero neither jammed nor folded: Nash only covers jam or fold.');
    } catch (err) {
      out.notes.push(`Nash failed: ${err.message}`);
    }
  }
  return out;
}

/** Hero decisions in a hand (states where hero acted). */
export function heroDecisions(states) {
  return states.filter((s) => s.isHero);
}
