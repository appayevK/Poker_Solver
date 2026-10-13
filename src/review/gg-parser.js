// GGPoker hand history parser → the internal Hand format (src/review/hand.js).
//
// Built against the real exports in tests/fixtures/hand-histories/. Line types seen there:
//   Poker Hand #HD...: Hold'em No Limit ($0.1/$0.25) - 2026/10/11 15:30:49
//   Table 'NLHRed23' 6-max Seat #4 is the button
//   Seat 3: Hero ($27.42 in chips)                       (opponents appear as hex ids)
//   X: posts small blind $0.1 / posts big blind $0.25    (a new player may post a live BB)
//   *** HOLE CARDS *** / Dealt to Hero [Jd Kh] / Dealt to X
//   X: folds / checks / calls $0.25 / bets $0.38 / raises $0.5 to $0.75 [and is all-in]
//   *** FLOP *** [Tc 3c 2c] / *** TURN *** [Tc 3c 2c] [4h] / *** RIVER *** [...] [4s]
//   *** FIRST FLOP *** ... *** SECOND TURN *** [Kc 4s As] [Kh]        (run it twice)
//   Uncalled bet ($0.25) returned to X
//   X: shows [Th 7d] (two pair, Tens and Fours)          (a folded player may show 1 card)
//   X: Chooses to EV Cashout / X: Pays Cashout Risk ($1.32)
//   *** SHOWDOWN *** / *** FIRST SHOWDOWN *** / X collected $3.32 from pot
//   *** SUMMARY *** / Total pot $3.49 | Rake $0.17 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
//   Board [...] / Hand was run two times / FIRST Board [...] / SECOND Board [Kh Kd]
//   Seat N: ... (summary lines, redundant with the actions)
// Tournament headers (Tournament #..., Level..(sb/bb(ante))), bounties in seat lines and
// Rush & Cash ids (RC...) are read from GG's documented layout but have no real fixture
// yet; hands that use them carry a warning saying so.
// Any other line is kept in hand.unparsed and reported in the warnings.

import { createHand } from './hand.js';
import { parseCards } from '../engine/cards.js';

const HEADER = /^Poker Hand #(\S+?):\s*(.*)$/;
const STAKES = /\((\$?)([\d.,]+)\/\$?([\d.,]+)\)/;
const DATE = /(\d{4})\/(\d{2})\/(\d{2}) (\d{1,2}):(\d{2}):(\d{2})/;
const TOURNAMENT = /Tournament #(\d+)/;
const LEVEL = /Level\s*(\d+)\s*\(([\d,.]+)\/([\d,.]+)(?:\(([\d,.]+)\))?\)/;
const TABLE = /^Table '([^']*)' (\d+)-max Seat #(\d+) is the button/;
const SEAT = /^Seat (\d+): (.+?) \(([^()]*in chips[^()]*)\)(.*)$/;
const STREET = /^\*\*\* (?:(FIRST|SECOND) )?(FLOP|TURN|RIVER) \*\*\*\s*(.*)$/;
const SHOWDOWN = /^\*\*\* (?:(FIRST|SECOND) )?SHOWDOWN \*\*\*$/;
const AMOUNT = '(\\$?[\\d.,]+)';
const POST_KINDS = { 'small blind': 'sb', 'big blind': 'bb', 'the ante': 'ante', ante: 'ante', straddle: 'straddle' };

/** Splits a pasted blob or file into single hand texts (each starts with "Poker Hand #"). */
export function splitHands(text) {
  const lines = String(text ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/);
  const hands = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('Poker Hand #')) {
      if (current) hands.push(current.join('\n').trim());
      current = [line];
    } else if (current) current.push(line);
  }
  if (current) hands.push(current.join('\n').trim());
  return hands.filter(Boolean);
}

const groups = (text) => [...text.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);

/** Parses one GG hand → { hand, warnings }. Throws when the hand cannot be read at all. */
export function parseGGHand(text) {
  const lines = String(text)
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  const warnings = [];
  const unparsed = [];
  const header = HEADER.exec(lines[0] ?? '');
  if (!header) throw new Error('Not a GGPoker hand: the first line should start with "Poker Hand #"');
  const [, id, rest] = header;

  const tournamentId = TOURNAMENT.exec(rest)?.[1] ?? null;
  const level = LEVEL.exec(rest);
  const stakes = STAKES.exec(rest);
  const currency = tournamentId ? null : stakes?.[1] ? '$' : null;
  const scale = currency ? 100 : 1;
  const amount = (s) => {
    const x = Number(String(s).replace(/[$,]/g, ''));
    if (!Number.isFinite(x)) throw new Error(`Bad amount "${s}"`);
    const units = Math.round(x * scale);
    if (Math.abs(units - x * scale) > 1e-6) warnings.push(`Amount ${s} has more precision than the unit; rounded`);
    return units;
  };
  let blinds;
  if (level) blinds = { sb: amount(level[2]), bb: amount(level[3]), ante: level[4] ? amount(level[4]) : 0, bbAnte: false };
  else if (stakes) blinds = { sb: amount(stakes[2]), bb: amount(stakes[3]), ante: 0, bbAnte: false };
  else throw new Error(`Hand ${id}: could not read the blinds from "${rest}"`);
  const d = DATE.exec(rest);
  const date = d ? `${d[1]}-${d[2]}-${d[3]}T${d[4].padStart(2, '0')}:${d[5]}:${d[6]}` : null;
  if (!d) warnings.push('No date in the header');

  const table = TABLE.exec(lines[1] ?? '');
  if (!table) throw new Error(`Hand ${id}: the second line should name the table and the button seat`);
  const [, tableName, maxSeats, button] = table;

  const players = [];
  let i = 2;
  for (; i < lines.length; i++) {
    const m = SEAT.exec(lines[i]);
    if (!m) break;
    const [, seat, name, inside, after] = m;
    const chips = /(\$?[\d.,]+) in chips/.exec(inside);
    const bounty = /(\$?[\d.,]+) bounty/.exec(inside);
    players.push({ seat: Number(seat), name, stack: amount(chips[1]), bounty: bounty ? Number(bounty[1].replace(/[$,]/g, '')) : null });
    if (after.trim()) warnings.push(`Seat ${seat}: ignored "${after.trim()}"`);
  }
  if (players.length < 2) throw new Error(`Hand ${id}: fewer than two seats found`);
  const names = players.map((p) => p.name).sort((a, b) => b.length - a.length);
  const nameAt = (line, sep) => names.find((n) => line.startsWith(n + sep));

  const actions = [];
  const shows = [];
  const uncalled = [];
  const collected = [];
  const cashout = [];
  const dealt = new Map();
  const fees = {};
  let pot = null;
  let rake = 0;
  let street = 'preflop';
  let section = 'posts';
  let run = 0;
  let runs = 1;
  const board1 = [];
  let board2 = null;
  let summaryBoards = {};
  // Street contributions, to turn "raises X to Y" into chips added and check X.
  let inStreet = new Map();
  let bet = 0;

  const toCards = (s) => parseCards(s.trim());

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '*** HOLE CARDS ***') {
      section = 'hand';
      continue;
    }
    const st = STREET.exec(line);
    if (st) {
      const [, which, name, cardsText] = st;
      const cards = groups(cardsText).flatMap((g) => toCards(g));
      if (which === 'SECOND') {
        board2 = cards;
        runs = Math.max(runs, 2);
      } else {
        board1.splice(0, board1.length, ...cards);
        street = name.toLowerCase();
        inStreet = new Map();
        bet = 0;
        if (which === 'FIRST') runs = Math.max(runs, 2);
      }
      section = 'hand';
      continue;
    }
    const sd = SHOWDOWN.exec(line);
    if (sd) {
      section = 'showdown';
      run = sd[1] === 'SECOND' ? 2 : sd[1] === 'FIRST' ? 1 : 0;
      continue;
    }
    if (line === '*** SUMMARY ***') {
      section = 'summary';
      continue;
    }

    if (section === 'summary') {
      let m;
      if ((m = new RegExp(`^Total pot ${AMOUNT}(.*)$`).exec(line))) {
        pot = amount(m[1]);
        for (const [, key, value] of m[2].matchAll(/\|\s*([A-Za-z][A-Za-z ]*?)\s+(\$?[\d.,]+)/g)) {
          if (key === 'Rake') rake = amount(value);
          else fees[key.toLowerCase()] = amount(value);
        }
      } else if ((m = /^(?:(FIRST|SECOND) )?Board \[(.*)\]$/.exec(line))) summaryBoards[m[1] ?? 'ONLY'] = toCards(m[2]);
      else if ((m = /^Hand was run (two|three) times$/.exec(line))) runs = m[1] === 'two' ? 2 : 3;
      else if (/^Seat \d+: /.test(line)) {
        // Summary seat lines repeat what the actions already say.
      } else unparsed.push(line);
      continue;
    }

    let m;
    if ((m = /^Dealt to (.+?)(?: \[(.+)\])?$/.exec(line)) && names.includes(m[1])) {
      if (m[2]) dealt.set(m[1], toCards(m[2]));
      continue;
    }
    if ((m = new RegExp(`^Uncalled bet \\(${AMOUNT}\\) returned to (.+)$`).exec(line)) && names.includes(m[2])) {
      uncalled.push({ player: m[2], amount: amount(m[1]) });
      continue;
    }
    const collector = nameAt(line, ' collected ');
    if (collector && (m = new RegExp(`^ collected ${AMOUNT} from (?:main |side )?pot`).exec(line.slice(collector.length)))) {
      collected.push({ player: collector, amount: amount(m[1]), ...(run ? { run } : {}) });
      continue;
    }

    const name = nameAt(line, ': ');
    if (!name) {
      unparsed.push(line);
      continue;
    }
    const what = line.slice(name.length + 2);
    const allIn = / and is all-in$/.test(what);
    const body = what.replace(/ and is all-in$/, '');
    const contributed = inStreet.get(name) ?? 0;
    if ((m = new RegExp(`^posts (small blind|big blind|the ante|ante|straddle|.+?) ${AMOUNT}$`).exec(body))) {
      const kind = POST_KINDS[m[1]] ?? 'dead';
      if (!POST_KINDS[m[1]]) warnings.push(`${name} posts "${m[1]}": treated as a dead post`);
      const amt = amount(m[2]);
      actions.push({ street, player: name, type: 'post', post: kind, amount: amt, isAllIn: allIn });
      if (kind !== 'ante' && kind !== 'dead') {
        inStreet.set(name, contributed + amt);
        bet = Math.max(bet, contributed + amt);
      }
    } else if (body === 'folds') actions.push({ street, player: name, type: 'fold' });
    else if (body === 'checks') actions.push({ street, player: name, type: 'check' });
    else if ((m = new RegExp(`^calls ${AMOUNT}$`).exec(body))) {
      const amt = amount(m[1]);
      actions.push({ street, player: name, type: 'call', amount: amt, to: contributed + amt, isAllIn: allIn });
      inStreet.set(name, contributed + amt);
    } else if ((m = new RegExp(`^bets ${AMOUNT}$`).exec(body))) {
      const amt = amount(m[1]);
      actions.push({ street, player: name, type: 'bet', amount: amt, to: contributed + amt, isAllIn: allIn });
      inStreet.set(name, contributed + amt);
      bet = contributed + amt;
    } else if ((m = new RegExp(`^raises ${AMOUNT} to ${AMOUNT}$`).exec(body))) {
      const by = amount(m[1]);
      const to = amount(m[2]);
      if (to - bet !== by) warnings.push(`${name} raises ${m[1]} to ${m[2]}, but the bet was ${bet}`);
      actions.push({ street, player: name, type: 'raise', amount: to - contributed, to, isAllIn: allIn });
      inStreet.set(name, to);
      bet = to;
    } else if ((m = /^shows \[(.*)\](?: \((.*)\))?$/.exec(body))) {
      shows.push({ player: name, cards: toCards(m[1]), ...(m[2] ? { description: m[2] } : {}) });
    } else if (body === 'Chooses to EV Cashout') cashout.push({ player: name, type: 'evCashout', amount: null });
    else if ((m = new RegExp(`^Pays Cashout Risk \\(${AMOUNT}\\)$`).exec(body))) cashout.push({ player: name, type: 'cashoutRisk', amount: amount(m[1]) });
    else unparsed.push(line);
  }

  // Hero: the player dealt visible cards ("Hero" in GG exports).
  const heroName = dealt.has('Hero') ? 'Hero' : (dealt.keys().next().value ?? null);
  for (const p of players) {
    p.cards = dealt.get(p.name) ?? null;
    const shown = shows.find((s) => s.player === p.name && s.cards.length === 2);
    if (!p.cards && shown) p.cards = shown.cards;
  }
  const antes = actions.filter((a) => a.type === 'post' && a.post === 'ante');
  if (antes.length) {
    blinds.ante = Math.max(...antes.map((a) => a.amount));
    blinds.bbAnte = antes.length === 1 && players.length > 2;
  }

  if (runs > 1 && !board2) warnings.push('The hand was run twice but the second board is missing');
  const boards = runs > 1 && board2 ? [board1.slice(), board2] : null;
  if (summaryBoards.ONLY && summaryBoards.ONLY.join() !== board1.join()) warnings.push('The summary board differs from the dealt board');

  const pko = players.some((p) => p.bounty !== null) || /bounty|pko|knockout/i.test(rest);
  const format = tournamentId ? (pko ? 'pko' : 'mtt') : 'cash';
  const variant = tournamentId ? null : /^RC/.test(id) || /rush/i.test(tableName) ? 'rushAndCash' : 'regular';
  if (tournamentId || variant === 'rushAndCash') warnings.push(`${format === 'cash' ? 'Rush & Cash' : 'Tournament'} hands have no real fixture yet; check this hand's numbers`);
  const tournament = tournamentId
    ? {
        id: tournamentId,
        name: rest.replace(/^.*Tournament #\d+,\s*/, '').replace(/\s*-\s*Level.*$/, '').trim() || null,
        buyIn: null,
        level: level ? Number(level[1]) : null,
        payouts: null,
        playersLeft: null,
      }
    : null;
  for (const line of unparsed) warnings.push(`Unrecognised line: ${line}`);

  const hand = createHand({
    id,
    site: 'gg',
    format,
    variant,
    date,
    table: tableName,
    maxSeats: Number(maxSeats),
    button: Number(button),
    unit: { currency, scale },
    blinds,
    straddle: actions.find((a) => a.post === 'straddle')?.amount ?? null,
    players,
    hero: heroName,
    actions,
    board: board1,
    boards,
    uncalled,
    collected,
    shows,
    pot,
    rake,
    fees,
    cashout,
    tournament,
    unparsed,
  });
  return { hand, warnings };
}

/**
 * Parses a whole file or pasted blob. One bad hand does not stop the rest:
 * { hands: [{ hand, warnings }], errors: [{ index, id, message }] }.
 */
export function parseGGFile(text) {
  const hands = [];
  const errors = [];
  splitHands(text).forEach((chunk, index) => {
    try {
      hands.push(parseGGHand(chunk));
    } catch (err) {
      errors.push({ index, id: HEADER.exec(chunk.split(/\r?\n/)[0])?.[1] ?? null, message: err.message });
    }
  });
  return { hands, errors };
}
