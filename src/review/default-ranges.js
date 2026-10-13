// Starting villain ranges for hand review, by position and preflop action.
//
// These are rough defaults to get the analysis going; the user edits them in the range
// grid, and after the flop narrows them by hand. For 6-max cash hands the open / call /
// 3-bet / 4-bet ranges come from the baseline chart (src/preflop/charts.js) when the spot
// exists there, so review and the Ranges tab agree; everything else uses the table below.

import { loadChart, spotRange } from '../preflop/charts.js';
import { rangeToString } from '../engine/ranges.js';

const ANY_TWO = '22+,A2s+,K2s+,Q2s+,J2s+,T2s+,92s+,82s+,72s+,62s+,52s+,42s+,32s,A2o+,K2o+,Q2o+,J2o+,T2o+,92o+,82o+,72o+,62o+,52o+,42o+,32o';

/** Open-raise ranges by position (9-max names; 6-max uses UTG, HJ, CO, BTN, SB). */
export const OPEN = {
  UTG: '66+,ATs+,KTs+,QTs+,JTs,T9s,AJo+,KQo',
  'UTG+1': '55+,A9s+,KTs+,QTs+,JTs,T9s,98s,AJo+,KQo',
  MP: '55+,A8s+,A5s,K9s+,Q9s+,J9s+,T9s,98s,ATo+,KJo+',
  LJ: '44+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,ATo+,KJo+,QJo',
  HJ: '33+,A2s+,K8s+,Q9s+,J9s+,T8s+,97s+,87s,76s,ATo+,KTo+,QJo',
  CO: '22+,A2s+,K6s+,Q8s+,J8s+,T8s+,97s+,86s+,76s,65s,A8o+,KTo+,QTo+,JTo',
  BTN: '22+,A2s+,K2s+,Q5s+,J7s+,T7s+,96s+,86s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T9o,98o',
  SB: '22+,A2s+,K4s+,Q7s+,J7s+,T7s+,97s+,86s+,76s,65s,54s,A5o+,K9o+,QTo+,JTo',
  BB: '22+,A2s+,K8s+,Q9s+,J9s+,T9s,ATo+,KJo+',
};

/** Flat call of an open, by the caller's position. */
export const CALL_OPEN = {
  BB: '22-99,A2s-AJs,K2s-KJs,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o-AJo,K8o+,Q9o+,J9o+,T8o+,98o',
  SB: '22-99,A9s-AJs,KTs+,QTs+,JTs,T9s,98s,AJo,KQo',
  BTN: '22-TT,A9s-AJs,KTs+,QTs+,J9s+,T9s,98s,87s,76s,AJo-AQo,KQo',
  default: '22-JJ,ATs-AQs,KTs+,QTs+,JTs,T9s,98s,AQo,KQo',
};

/** 3-bet vs an open. */
export const THREE_BET = {
  BB: 'TT+,AJs+,KQs,A5s-A4s,AQo+',
  SB: '99+,ATs+,KJs+,QJs,A5s-A4s,AJo+,KQo',
  BTN: 'TT+,AJs+,KQs,A5s-A4s,AQo+',
  default: 'JJ+,AQs+,A5s,AKo',
};

/** Call a 3-bet (the opener). */
export const CALL_THREE_BET = { default: '77-QQ,ATs-AQs,KJs+,QJs,JTs,T9s,AQo' };
export const FOUR_BET = { default: 'KK+,AKs,AKo,A5s' };
export const CALL_FOUR_BET = { default: 'QQ+,AK' };
export const LIMP = { default: '22-99,A2s-A9s,K9s-KTs,QTs,JTs,T9s,98s,87s,76s,65s,ATo-AJo,KJo,QJo' };

/** Open-jam by effective stack (bb); later positions jam a little wider. */
export const OPEN_JAM = [
  { upTo: 8, early: '22+,A2s+,A5o+,K6s+,KTo+,Q9s+,QJo,J9s+,T9s', late: '22+,A2+,K2s+,K7o+,Q5s+,Q9o+,J7s+,J9o+,T7s+,T9o,97s+,86s+,76s,65s' },
  { upTo: 12, early: '33+,A7s+,A5s,ATo+,KTs+,KQo,QJs', late: '22+,A2s+,A7o+,K8s+,KTo+,Q9s+,QJo,J9s+,T9s' },
  { upTo: 20, early: '66+,ATs+,AJo+,KQs', late: '44+,A8s+,A5s,ATo+,KTs+,KQo,QJs' },
];

/** Calling an all-in, by the jammer's stack (bb). */
export const CALL_JAM = [
  { upTo: 10, range: '22+,A2s+,A7o+,K9s+,KQo,QJs' },
  { upTo: 20, range: '55+,A9s+,ATo+,KQs' },
  { upTo: Infinity, range: 'TT+,AQs+,AKo' },
];

const LATE = new Set(['CO', 'BTN', 'SB']);
const pick = (table, position) => table[position] ?? table.default;

/** Range string for a position and preflop action ('open', 'callOpen', 'threeBet', ...). */
export function defaultRange(position, action, { stackBB = 100 } = {}) {
  switch (action) {
    case 'open':
      return OPEN[position] ?? OPEN.CO;
    case 'callOpen':
      return pick(CALL_OPEN, position);
    case 'threeBet':
      return pick(THREE_BET, position);
    case 'callThreeBet':
      return pick(CALL_THREE_BET, position);
    case 'fourBet':
    case 'jam':
      return pick(FOUR_BET, position);
    case 'callFourBet':
      return pick(CALL_FOUR_BET, position);
    case 'limp':
      return pick(LIMP, position);
    case 'openJam': {
      const row = OPEN_JAM.find((r) => stackBB <= r.upTo);
      return row ? (LATE.has(position) ? row.late : row.early) : OPEN[position] ?? OPEN.CO;
    }
    case 'callJam':
      return CALL_JAM.find((r) => stackBB <= r.upTo).range;
    case 'bbCheck':
    default:
      return ANY_TWO;
  }
}

const LABELS = {
  open: 'open',
  callOpen: 'call vs an open',
  threeBet: '3-bet',
  callThreeBet: 'call vs a 3-bet',
  fourBet: '4-bet',
  callFourBet: 'call vs a 4-bet',
  limp: 'limp',
  openJam: 'open-jam',
  callJam: 'call vs an all-in',
  bbCheck: 'check in the big blind',
  jam: 'all-in re-raise',
  none: 'no preflop action yet',
};

/**
 * What a player did preflop, read from the hand up to (not including) action index
 * `before`: { action, opener, threeBettor } where action is one of the keys above.
 * The player's last voluntary action decides (open then call a 3-bet → callThreeBet).
 */
export function preflopLine(hand, player, before = hand.actions.length) {
  let raises = 0;
  let opener = null;
  let threeBettor = null;
  let jammer = null;
  let line = 'none';
  const bb = hand.blinds.bb;
  const stacks = new Map(hand.players.map((p) => [p.name, p.stack]));
  for (let i = 0; i < Math.min(before, hand.actions.length); i++) {
    const a = hand.actions[i];
    if (a.street !== 'preflop') break;
    if (a.type === 'post') continue;
    if (a.player === player) {
      if (a.type === 'raise' || a.type === 'bet') {
        if (raises === 0) line = a.isAllIn && stacks.get(player) / bb <= 20 ? 'openJam' : 'open';
        else if (raises === 1) line = a.isAllIn && stacks.get(player) / bb <= 25 ? 'jam' : 'threeBet';
        else line = raises === 2 ? 'fourBet' : 'jam';
      } else if (a.type === 'call') {
        if (raises === 0) line = 'limp';
        else if (jammer && raises === 1) line = 'callJam';
        else line = raises === 1 ? 'callOpen' : raises === 2 ? 'callThreeBet' : 'callFourBet';
      } else if (a.type === 'check') line = 'bbCheck';
    }
    if (a.type === 'raise' || a.type === 'bet') {
      raises++;
      if (raises === 1) {
        opener = a.player;
        if (a.isAllIn) jammer = a.player;
      } else if (raises === 2) threeBettor = a.player;
    }
  }
  return { action: line, opener, threeBettor, label: LABELS[line] };
}

let chart = null;
function chartRange(spotId, action) {
  try {
    chart ??= loadChart();
    const range = spotRange(chart, spotId, action);
    return range.size ? rangeToString(range) : null;
  } catch {
    return null;
  }
}

const positionOf = (hand, name) => hand.players.find((p) => p.name === name)?.position ?? null;

/**
 * Default range for a villain at an action index: { range, label, source }.
 * source is 'chart' (baseline chart spot) or 'table' (the defaults above).
 */
export function defaultVillainRange(hand, villain, before = hand.actions.length) {
  const position = positionOf(hand, villain);
  const line = preflopLine(hand, villain, before);
  const stackBB = (hand.players.find((p) => p.name === villain)?.stack ?? 0) / hand.blinds.bb;
  const label = `${position ?? villain} ${line.label}`;
  if (hand.format === 'cash' && hand.maxSeats <= 6 && position) {
    const opener = positionOf(hand, line.opener);
    const threeBettor = positionOf(hand, line.threeBettor);
    const fromChart =
      line.action === 'open'
        ? chartRange(`RFI:${position}`, 'raise')
        : line.action === 'callOpen' && opener
          ? chartRange(`vsOpen:${position}:${opener}`, 'call')
          : line.action === 'threeBet' && opener
            ? chartRange(`vsOpen:${position}:${opener}`, 'raise')
            : line.action === 'callThreeBet' && threeBettor && line.opener === villain
              ? chartRange(`vs3bet:${position}:${threeBettor}`, 'call')
              : line.action === 'fourBet' && threeBettor && line.opener === villain
                ? chartRange(`vs3bet:${position}:${threeBettor}`, 'raise')
                : null;
    if (fromChart) return { range: fromChart, label, source: 'chart' };
  }
  return { range: defaultRange(position, line.action, { stackBB }), label, source: 'table' };
}
