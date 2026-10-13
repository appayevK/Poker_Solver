import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { splitHands, parseGGHand, parseGGFile } from '../src/review/gg-parser.js';
import { validateHand, results } from '../src/review/hand.js';
import { cardsToString } from '../src/engine/cards.js';

const DIR = 'tests/fixtures/hand-histories';
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.txt'));
const read = (f) => readFileSync(`${DIR}/${f}`, 'utf8');
const cash = parseGGFile(read('cash-nl25-01.txt'));
const byId = (id) => cash.hands.find((h) => h.hand.id === id).hand;
const winners = (hand) => hand.collected.map((c) => [c.player, c.amount, c.run ?? 0]);

describe('GG parser: every fixture', () => {
  it('has at least one real export', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    it(`${file} parses with no errors or warnings and every hand is consistent`, () => {
      const { hands, errors } = parseGGFile(read(file));
      expect(errors).toEqual([]);
      expect(hands.length).toBe(splitHands(read(file)).length);
      for (const { hand, warnings } of hands) {
        expect(warnings, hand.id).toEqual([]);
        expect(hand.unparsed, hand.id).toEqual([]);
        expect(validateHand(hand), hand.id).toEqual([]);
      }
    });
  }
});

describe('GG parser: cash NL25 fixture (expectations read from the file)', () => {
  it('reads all 19 hands', () => {
    expect(cash.hands).toHaveLength(19);
    expect(cash.hands.every(({ hand }) => hand.format === 'cash' && hand.variant === 'regular' && hand.site === 'gg')).toBe(true);
  });

  it('reads a showdown hand: hero cards, players, blinds, board, pot, winner', () => {
    const h = byId('HD3083051249');
    expect(cardsToString(h.players.find((p) => p.isHero).cards)).toBe('JdKh');
    expect(h.players).toHaveLength(5);
    expect(h.blinds).toEqual({ sb: 10, bb: 25, ante: 0, bbAnte: false });
    expect(h.unit).toEqual({ currency: '$', scale: 100 });
    expect(cardsToString(h.board)).toBe('Tc3c2c4h4s');
    expect(h.pot).toBe(349);
    expect(h.rake).toBe(17);
    expect(h.fees).toEqual({ jackpot: 0, bingo: 0, fortune: 0, tax: 0 });
    expect(winners(h)).toEqual([['ddfecbb0', 332, 0]]);
    expect(h.date).toBe('2026-10-11T15:30:49');
    expect(h.table).toBe('NLHRed23');
    expect(h.button).toBe(4);
    // Both players showed down.
    expect(cardsToString(h.players.find((p) => p.name === 'c4e5faf1').cards)).toBe('3sAs');
    expect(cardsToString(h.players.find((p) => p.name === 'ddfecbb0').cards)).toBe('Th7d');
  });

  it('computes positions from the button with empty seats (5-handed 6-max)', () => {
    const h = byId('HD3083051249');
    expect(Object.fromEntries(h.players.map((p) => [p.seat, p.position]))).toEqual({ 1: 'BB', 2: 'HJ', 3: 'CO', 4: 'BTN', 5: 'SB' });
    const four = byId('HD3083050575'); // seats 1, 3, 4, 5; button 4
    expect(Object.fromEntries(four.players.map((p) => [p.seat, p.position]))).toEqual({ 1: 'BB', 3: 'CO', 4: 'BTN', 5: 'SB' });
  });

  it('turns "raises X to Y" into chips added and the street total', () => {
    const h = byId('HD3083050982');
    const raise = h.actions.find((a) => a.type === 'raise');
    // SB had 0.10 in: "raises $0.5 to $0.75" adds 0.65.
    expect(raise).toMatchObject({ player: 'b48f0e7e', amount: 65, to: 75, isAllIn: false });
    expect(h.uncalled).toEqual([{ player: 'b48f0e7e', amount: 50 }]);
  });

  it('reads all-ins, uncalled bets and a folded player showing one card', () => {
    const h = byId('HD3083049734');
    expect(cardsToString(h.players.find((p) => p.isHero).cards)).toBe('KhAc');
    expect(h.players).toHaveLength(6);
    expect(cardsToString(h.board)).toBe('7c2cTh7d7s');
    expect(h.pot).toBe(1837);
    expect(winners(h)).toEqual([['c4e5faf1', 1704, 0]]);
    expect(h.uncalled).toEqual([{ player: 'Hero', amount: 343 }]);
    expect(h.actions.find((a) => a.player === 'c4e5faf1' && a.isAllIn)).toMatchObject({ type: 'call', amount: 498 });
    expect(h.shows.map((s) => [s.player, cardsToString(s.cards)])).toEqual([
      ['Hero', 'KhAc'],
      ['c4e5faf1', 'KsTs'],
      ['33f0aa9c', '7h'],
    ]);
    // One shown card is not a holding.
    expect(h.players.find((p) => p.name === '33f0aa9c').cards).toBeNull();
    expect(results(h).get('Hero').net).toBe(-882);
  });

  it('reads run it twice: both boards, both showdowns and the jackpot fee', () => {
    const h = byId('HD3083050284');
    expect(h.boards.map((b) => cardsToString(b))).toEqual(['Kc4sAs5h6d', 'Kc4sAsKhKd']);
    expect(cardsToString(h.board)).toBe('Kc4sAs5h6d');
    expect(winners(h)).toEqual([
      ['ddfecbb0', 637, 1],
      ['b48f0e7e', 637, 2],
    ]);
    expect(h.pot).toBe(1365);
    expect(h.rake).toBe(66);
    expect(h.fees.jackpot).toBe(25);
    // The flop all-in happened on the flop, not on a separate "first" street.
    expect(h.actions.filter((a) => a.street === 'flop').map((a) => a.type)).toEqual(['bet', 'fold', 'raise', 'call']);
  });

  it('reads EV cashout and charges the cashout risk to the stack', () => {
    const h = byId('HD3083050094');
    expect(h.cashout).toEqual([
      { player: '33f0aa9c', type: 'evCashout', amount: null },
      { player: '33f0aa9c', type: 'cashoutRisk', amount: 132 },
    ]);
    expect(winners(h)).toEqual([['33f0aa9c', 904, 0]]);
    // 9.04 won - 1.32 cashout risk: the next hand starts with $7.72.
    expect(results(h).get('33f0aa9c').end).toBe(772);
    expect(byId('HD3083050284').players.find((p) => p.name === '33f0aa9c').stack).toBe(772);
  });

  it('keeps a live big blind posted by a new player, who may then check', () => {
    const h = byId('HD3083049674');
    const posts = h.actions.filter((a) => a.type === 'post').map((a) => [a.player, a.post, a.amount]);
    expect(posts).toEqual([
      ['c4e5faf1', 'sb', 10],
      ['ddfecbb0', 'bb', 25],
      ['33f0aa9c', 'bb', 25],
    ]);
    expect(h.actions.find((a) => a.type !== 'post')).toMatchObject({ player: '33f0aa9c', type: 'check' });
    expect(h.players.find((p) => p.name === '33f0aa9c').position).toBe('UTG');
    expect(h.pot).toBe(171);
  });

  it('reads a walk (no board, hero collects the blinds)', () => {
    const h = byId('HD3083051013');
    expect(h.board).toEqual([]);
    expect(h.uncalled).toEqual([{ player: 'Hero', amount: 15 }]);
    expect(winners(h)).toEqual([['Hero', 20, 0]]);
  });

  it('chains stacks: every player ends a hand with what they start the next one with, or tops up', () => {
    const hands = cash.hands.map((x) => x.hand).sort((a, b) => a.date.localeCompare(b.date));
    let exact = 0;
    for (let k = 0; k + 1 < hands.length; k++) {
      const end = results(hands[k]);
      for (const p of hands[k + 1].players) {
        const r = end.get(p.name);
        if (!r) continue;
        expect(p.stack, `${p.name} after ${hands[k].id}`).toBeGreaterThanOrEqual(r.end);
        if (p.stack === r.end) exact++;
      }
    }
    expect(exact).toBe(79);
  });
});

describe('GG parser: robustness', () => {
  const one = splitHands(read('cash-nl25-01.txt'))[0];

  it('splits pasted text with CRLF line endings and a byte-order mark', () => {
    const text = '﻿' + read('cash-nl25-01.txt').replace(/\n/g, '\r\n');
    const { hands, errors } = parseGGFile(text);
    expect(errors).toEqual([]);
    expect(hands).toHaveLength(19);
  });

  it('keeps going when one hand is broken', () => {
    const broken = "Poker Hand #HD1: Hold'em No Limit ($0.1/$0.25) - 2026/10/11 15:00:00\nnot a table line";
    const { hands, errors } = parseGGFile(`${broken}\n\n${one}`);
    expect(hands).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ index: 0, id: 'HD1' });
  });

  it('keeps unknown lines in hand.unparsed and reports them', () => {
    const text = one.replace('*** HOLE CARDS ***', '*** HOLE CARDS ***\nb48f0e7e: waves at the table');
    const { hand, warnings } = parseGGHand(text);
    expect(hand.unparsed).toEqual(['b48f0e7e: waves at the table']);
    expect(warnings).toContain('Unrecognised line: b48f0e7e: waves at the table');
  });

  it('marks Rush & Cash hands by their RC id (as shown in GG, e.g. #RC4871318338)', () => {
    const { hand, warnings } = parseGGHand(one.replace('Poker Hand #HD', 'Poker Hand #RC'));
    expect(hand.variant).toBe('rushAndCash');
    expect(warnings.some((w) => /no real fixture/.test(w))).toBe(true);
  });

  it.todo('parses a real Rush & Cash export (needs a GG Rush & Cash file in tests/fixtures/hand-histories)');
  it.todo('parses a real PKO export and reads bounties (needs a GG PKO file in tests/fixtures/hand-histories)');
});
