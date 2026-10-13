import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGGFile } from '../src/review/gg-parser.js';
import { handStats, sessionStats, detectSessionLeaks } from '../src/review/session-leaks.js';
import { chipsHand, act } from './helpers/make-hand.js';

// Heads-up hands (hero on the button = SB) in time order. kind:
//   fold   hero folds preflop (no VPIP)
//   call   hero limps, villain checks and wins nothing (pot split for simplicity)
//   raise  hero raises, villain folds
//   lose   hero raises to 40 bb, villain calls, villain wins (a big loss)
let n = 0;
function hand(kind) {
  n++;
  const actions = [act('Hero', 'sb', 50), act('Villain', 'bb', 100)];
  let collected = [];
  let uncalled = [];
  if (kind === 'fold') {
    actions.push(act('Hero', 'fold'));
    uncalled = [{ player: 'Villain', amount: 50 }];
    collected = [{ player: 'Villain', amount: 100 }];
  } else if (kind === 'call') {
    actions.push(act('Hero', 'call'), act('Villain', 'check'));
    collected = [{ player: 'Hero', amount: 100 }, { player: 'Villain', amount: 100 }];
  } else if (kind === 'raise') {
    actions.push(act('Hero', 'raise', 300), act('Villain', 'fold'));
    uncalled = [{ player: 'Hero', amount: 200 }];
    collected = [{ player: 'Hero', amount: 200 }];
  } else {
    actions.push(act('Hero', 'raise', 4000), act('Villain', 'call'));
    collected = [{ player: 'Villain', amount: 8000 }];
  }
  return chipsHand({
    id: `S${n}`,
    date: `2026-10-11T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`,
    button: 2,
    players: [
      ['Villain', 10000],
      ['Hero', 10000],
    ],
    actions,
    uncalled,
    collected,
  });
}
const repeat = (pattern, times) => Array.from({ length: times }, (_, i) => hand(pattern[i % pattern.length]));

describe('session stats', () => {
  it('counts VPIP, PFR and net bb', () => {
    const hands = [hand('fold'), hand('call'), hand('raise'), hand('lose')];
    expect(hands.map((h) => handStats(h).vpip)).toEqual([false, true, true, true]);
    expect(hands.map((h) => handStats(h).netBB)).toEqual([-0.5, 0, 1, -40]);
    const s = sessionStats(hands);
    expect(s).toMatchObject({ hands: 4, vpip: 0.75, pfr: 0.5, netBB: -39.5 });
    expect(s.byPosition.SB.hands).toBe(4);
  });

  it('summarises the real NL25 session', () => {
    const hands = parseGGFile(readFileSync('tests/fixtures/hand-histories/cash-nl25-01.txt', 'utf8')).hands.map((x) => x.hand);
    const s = sessionStats(hands);
    expect(s.hands).toBe(19);
    expect(s.netBB).toBeCloseTo(-41.04, 6);
    expect(s.vpip).toBeCloseTo(8 / 19, 12);
    expect(s.pfr).toBeCloseTo(7 / 19, 12);
    expect(detectSessionLeaks(hands)).toEqual([]);
  });
});

describe('session leaks', () => {
  it('stays quiet on a neutral session', () => {
    const hands = [...repeat(['call', 'fold'], 20), hand('lose'), ...repeat(['call', 'fold'], 20)];
    expect(detectSessionLeaks(hands)).toEqual([]);
  });

  it('flags playing much tighter after a big loss', () => {
    const hands = [...repeat(['call', 'fold'], 20), hand('lose'), ...repeat(['fold', 'fold', 'fold', 'fold', 'call'], 20)];
    const flags = detectSessionLeaks(hands);
    expect(flags.map((f) => f.type)).toEqual(['tightAfterLoss']);
    expect(flags[0].handId).toBe(hands[20].id);
    expect(flags[0].message).toMatch(/50%/);
  });

  it('flags getting more aggressive after a big loss', () => {
    const hands = [...repeat(['call', 'call', 'raise'], 21), hand('lose'), ...repeat(['raise', 'raise', 'call'], 21)];
    const types = detectSessionLeaks(hands).map((f) => f.type);
    expect(types).toContain('aggressionAfterLoss');
    expect(types).not.toContain('tightAfterLoss');
  });
});
