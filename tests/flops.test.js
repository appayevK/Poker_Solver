import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalFlop, allCanonicalFlops, mapCard, SUIT_PERMS } from '../src/flops/canonical.js';
import { flopFeatures, textureLabel, textureGroup, TEXTURE_GROUPS } from '../src/flops/texture.js';
import { getSpot, resolveSpot, solverRange } from '../src/flops/spots.js';
import { handClasses } from '../src/engine/ranges.js';
import { buildSolverInput } from '../src/flops/solver-input.js';
import { TREE_PRESETS, treePreset } from '../src/flops/tree-config.js';
import { extractFlop, parseSolverLog, parseActionLabel } from '../src/flops/extract.js';
import { quantize, dequantizeRow, base64ToBytes, base64ToUint16, uint16ToBase64 } from '../src/flops/codec.js';
import { configureLibrary, loadIndex, nearestAmong, nearestFlop, strategyFor } from '../src/flops/library.js';
import { textureReport, takeaways } from '../src/flops/reports.js';
import { dealFlopQuestion, scoreFlopAnswer, updateFlopStats } from '../src/flops/flop-trainer.js';
import { loadFlop } from '../src/flops/library.js';
import { loadChart, spotFrequencies } from '../src/preflop/charts.js';
import { parseCards, cardsToString } from '../src/engine/cards.js';
import { createRng } from '../src/engine/rng.js';
import subset from '../data/flops/subset.json' with { type: 'json' };

const FIXTURE = 'tests/fixtures/texassolver';
// The tree the fixture was solved with (tests/fixtures/texassolver/small-flop-input.txt).
const FIXTURE_TREE = {
  name: 'fixture',
  scale: 10,
  allinThreshold: 0.67,
  flop: { ipBet: [33], oopBet: { SRP: [] }, raise: [], allin: true },
  turn: { bet: [50], raise: [], allin: true },
  river: { bet: [50], raise: [], allin: true },
};
const FIXTURE_SOLVER = { accuracy: 1, maxIterations: 100, printInterval: 10, isomorphism: 1, dumpRounds: 1 };
const dump = JSON.parse(readFileSync(`${FIXTURE}/small-flop-output.json`, 'utf8'));
const fixtureData = () => extractFlop({ dump, spot: getSpot('srp-btn-bb'), flop: 'QsJh2h', tree: FIXTURE_TREE });

describe('flop texture', () => {
  it('labels hand-picked flops', () => {
    expect(textureLabel('AsKd2c')).toBe('A-high dry rainbow');
    expect(textureLabel('9h8h7h')).toBe('9-high connected monotone');
    expect(textureLabel('7s7d2c')).toBe('7-high paired rainbow');
    expect(textureLabel('Ks9h4h')).toBe('K-high two-tone');
    expect(textureLabel('5s4d3c')).toBe('5-high connected rainbow');
    expect(textureLabel('Ah2d3c')).toBe('A-high connected rainbow'); // wheel cards
    expect(textureLabel('8s8h8d')).toBe('8-high trips rainbow');
  });

  it('computes features and groups', () => {
    const f = flopFeatures('QsJh2h');
    expect(f).toMatchObject({ high: 10, middle: 9, low: 0, suitPattern: 'two-tone', pairing: 'unpaired', connected: false, straightDraws: true, flushDraw: true, broadways: 2 });
    expect(textureGroup('AsKd2c')).toBe('A-high dry');
    expect(textureGroup('Ks9h4h')).toBe('K-high wet');
    expect(textureGroup('9h8h7h')).toBe('Monotone');
    expect(textureGroup('7s7d2c')).toBe('Paired low');
    expect(textureGroup('QsQd5c')).toBe('Paired high');
    expect(textureGroup('5s4d2c')).toBe('Low wet');
  });
});

describe('canonical flops', () => {
  it('maps the 22,100 flops onto exactly 1,755 canonical flops', () => {
    const all = allCanonicalFlops();
    expect(all).toHaveLength(1755);
    expect(all.reduce((s, f) => s + f.raw, 0)).toBe(22100);
    expect(all.filter((f) => flopFeatures(f.cards).suitPattern === 'monotone').reduce((s, f) => s + f.raw, 0)).toBe(4 * 286);
  });

  it('gives isomorphic flops the same canonical form and a round-tripping permutation', () => {
    expect(canonicalFlop('AhKh2c').key).toBe(canonicalFlop('AdKd2s').key);
    expect(canonicalFlop('AhKh2c').key).toBe('AsKs2h');
    expect(canonicalFlop('AsKd2c').key).toBe('AsKh2d');
    expect(canonicalFlop('QsJh2h').key).toBe('QsJh2h');
    expect(canonicalFlop('QsJh2h').key).not.toBe(canonicalFlop('QsJs2h').key);
    const rng = createRng(1);
    for (let t = 0; t < 300; t++) {
      const cards = [];
      while (cards.length < 3) {
        const c = rng.int(52);
        if (!cards.includes(c)) cards.push(c);
      }
      const { cards: canon, perm, inverse } = canonicalFlop(cards);
      expect(cards.map((c) => mapCard(c, perm)).sort((a, b) => b - a)).toEqual(canon);
      expect(canon.map((c) => mapCard(c, inverse)).sort((a, b) => b - a)).toEqual([...cards].sort((a, b) => b - a));
      const other = SUIT_PERMS[rng.int(24)];
      expect(canonicalFlop(cards.map((c) => mapCard(c, other))).key).toBe(canonicalFlop(cards).key);
    }
  });
});

describe('flop subset', () => {
  it('weights sum to 1755 and every texture group is represented', () => {
    const reps = subset.representatives;
    expect(reps.length).toBeGreaterThanOrEqual(60);
    expect(reps.length).toBeLessThanOrEqual(90);
    expect(reps.reduce((s, r) => s + r.weight, 0)).toBe(1755);
    expect(reps.reduce((s, r) => s + r.raw, 0)).toBe(22100);
    for (const g of TEXTURE_GROUPS) expect(reps.some((r) => r.group === g), g).toBe(true);
  });

  it('assigns every canonical flop to exactly one representative of its own group', () => {
    const seen = new Set();
    for (const rep of subset.representatives) {
      expect(rep.members).toContain(rep.key);
      expect(rep.weight).toBe(rep.members.length);
      for (const key of rep.members) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        expect(textureGroup(key)).toBe(rep.group);
      }
    }
    expect(seen.size).toBe(1755);
  });
});

describe('flop spots', () => {
  it('computes pot and stack from the chart sizes', () => {
    // BTN opens 2.5, BB calls 1.5 more, SB's 0.5 is dead
    expect(getSpot('srp-btn-bb')).toMatchObject({ pot: 5.5, stack: 97.5, ip: 'BTN', oop: 'BB' });
    expect(getSpot('srp-co-bb')).toMatchObject({ pot: 5.5, stack: 97.5, ip: 'CO', oop: 'BB' });
    // SB 3-bets 4x to 10, BTN calls, BB's 1 is dead
    expect(getSpot('3bp-sb-btn')).toMatchObject({ pot: 21, stack: 90, ip: 'BTN', oop: 'SB' });
    // BB 3-bets 4x to 10, BTN calls, SB's 0.5 is dead
    expect(getSpot('3bp-bb-btn')).toMatchObject({ pot: 20.5, stack: 90, ip: 'BTN', oop: 'BB' });
  });

  it('takes both ranges from the baseline chart', () => {
    const chart = loadChart();
    const s = getSpot('3bp-sb-btn');
    expect(Array.from(s.ranges.oop)).toEqual(Array.from(spotFrequencies(chart, 'vsOpen:SB:BTN').raise));
    expect(Array.from(s.ranges.ip)).toEqual(Array.from(spotFrequencies(chart, 'vs3bet:BTN:SB').call));
    const b = getSpot('srp-btn-bb');
    expect(Array.from(b.ranges.ip)).toEqual(Array.from(spotFrequencies(chart, 'RFI:BTN').raise));
    expect(Array.from(b.ranges.oop)).toEqual(Array.from(spotFrequencies(chart, 'vsOpen:BB:BTN').call));
    expect(solverRange(b.ranges.oop)).toMatch(/^AJs:0\.5,ATs,/);
  });

  it('accepts a spot with its own stack, money and range strings (the README 30bb MTT example)', () => {
    const mtt = resolveSpot({
      id: 'mtt-btn-bb-30',
      label: 'MTT 30bb BTN vs BB',
      format: 'mtt',
      type: 'SRP',
      ip: 'BTN',
      oop: 'BB',
      aggressor: 'ip',
      preflop: 'BTN opens 2.1bb, SB folds, BB calls (1bb BB ante)',
      stack: 30,
      invested: 2.1,
      dead: 1.5,
      ranges: {
        ip: { range: '22+,A2s+,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,76s,65s,54s,A2o+,K9o+,QTo+,JTo' },
        oop: { range: '22-TT,A2s-AJs,K2s+,Q2s+,J5s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o-AJo,K7o+,Q9o+,J9o+,T9o,A5s:0.5' },
      },
    });
    expect(mtt).toMatchObject({ pot: 5.7, stack: 27.9 });
    const classes = handClasses();
    const at = (range, cls) => range[classes.indexOf(cls)];
    expect(at(mtt.ranges.ip, 'K9o')).toBe(1);
    expect(at(mtt.ranges.ip, 'K8o')).toBe(0);
    expect(at(mtt.ranges.oop, 'A5s')).toBe(0.5);
    expect(at(mtt.ranges.oop, 'JJ')).toBe(0);
    expect(buildSolverInput({ spot: mtt, flop: 'Ks9h4h', threads: 8, dumpPath: 'out.json' })).toMatch(/^set_pot 57\nset_effective_stack 279\n/);
  });
});

describe('solver input', () => {
  it('reproduces exactly the input file that ran in TexasSolver', () => {
    const text = buildSolverInput({
      spot: getSpot('srp-btn-bb'),
      flop: 'QsJh2h',
      threads: 16,
      tree: FIXTURE_TREE,
      solver: FIXTURE_SOLVER,
      dumpPath: 'C:/Users/Admin/Poker_Solver/tests/fixtures/texassolver/small-flop-output.json',
    });
    // Git may check the fixture out with CRLF line endings on Windows.
    expect(text).toBe(readFileSync(`${FIXTURE}/small-flop-input.txt`, 'utf8').replace(/\r\n/g, '\n'));
  });

  it('builds the laptop tree: no donk bets or IP re-raises in SRPs, OOP c-bets in 3-bet pots', () => {
    const lines = (spotId, tree = TREE_PRESETS.laptop) => buildSolverInput({ spot: getSpot(spotId), flop: 'Ks9h4h', threads: 8, tree, dumpPath: 'C:\\work\\out.json' }).split('\n');
    const srp = lines('srp-btn-bb');
    expect(srp).toContain('set_bet_sizes ip,flop,bet,33,75');
    expect(srp).toContain('set_bet_sizes oop,flop,raise,50');
    expect(srp.some((l) => l.startsWith('set_bet_sizes oop,flop,bet'))).toBe(false);
    expect(srp.some((l) => l.startsWith('set_bet_sizes ip,flop,raise'))).toBe(false);
    expect(srp.some((l) => /,flop,allin/.test(l))).toBe(false);
    expect(srp).toContain('set_bet_sizes oop,turn,bet,66');
    expect(srp).toContain('set_bet_sizes ip,river,allin');
    expect(srp.some((l) => /,$/.test(l))).toBe(false);
    expect(srp).toContain('dump_result C:/work/out.json');
    expect(srp).toContain('set_board Ks,9h,4h');
    expect(srp).toContain('set_pot 55');
    expect(srp).toContain('set_effective_stack 975');
    const tbp = lines('3bp-sb-btn');
    expect(tbp).toContain('set_bet_sizes oop,flop,bet,33');
    expect(tbp).toContain('set_bet_sizes ip,flop,raise,50');
    expect(tbp).toContain('set_pot 210');
    const full = lines('srp-btn-bb', treePreset('full'));
    expect(full).toContain('set_bet_sizes ip,turn,bet,50,100');
    expect(full).toContain('set_bet_sizes ip,flop,raise,50');
    expect(() => treePreset('huge')).toThrow(/Unknown tree/);
  });
});

describe('extraction from the real fixture', () => {
  it('reads progress from the UTF-16 console log', () => {
    const log = parseSolverLog(readFileSync(`${FIXTURE}/small-flop-log.txt`));
    expect(log.iterations).toBe(91);
    expect(log.exploitability).toBeCloseTo(1.23, 2);
    expect(log.timeUsed).toBeCloseTo(30.453, 3);
    expect(parseSolverLog('Iter: 5\nplayer 0 exploitability 1\nTotal exploitability 3.5 precent\ntime used: 2').iterations).toBe(5);
  });

  it('parses action labels', () => {
    expect(parseActionLabel('BET 18.000000')).toEqual({ type: 'bet', chips: 18 });
    expect(parseActionLabel('RAISE 975.000000')).toEqual({ type: 'raise', chips: 975 });
    expect(parseActionLabel('CHECK')).toEqual({ type: 'check', chips: null });
  });

  it('reads the flop decisions, actions and sizes', () => {
    const data = fixtureData();
    expect(data.nodes.map((n) => n.id).sort()).toEqual(['ip-vs-allin', 'ip-vs-check', 'oop-root', 'oop-vs-allin', 'oop-vs-bet33'].sort());
    const vsCheck = data.nodes.find((n) => n.id === 'ip-vs-check');
    expect(vsCheck.player).toBe('ip');
    expect(vsCheck.actions.map((a) => a.key)).toEqual(['check', 'bet33', 'allin']);
    expect(vsCheck.actions[1]).toMatchObject({ type: 'bet', bb: 1.8 });
    const facing = data.nodes.find((n) => n.id === 'oop-vs-bet33');
    expect(facing.actions.map((a) => a.key)).toEqual(['call', 'allin', 'fold']);
    expect(facing.label).toBe('BB vs BTN 33% bet (1.8bb)');
    for (const n of data.nodes) {
      expect(n.summary.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
      for (const f of n.summary) expect(f).toBeGreaterThanOrEqual(0);
    }
  });

  it('orders the decisions along the check line and records how often each comes up', () => {
    const data = fixtureData();
    expect(data.nodes.map((n) => n.id)).toEqual(['oop-root', 'ip-vs-check', 'oop-vs-bet33', 'oop-vs-allin', 'ip-vs-allin']);
    const by = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
    const freq = (id, key) => by[id].summary[by[id].actions.findIndex((a) => a.key === key)];
    expect(by['oop-root'].line).toBe(1);
    expect(by['ip-vs-check'].line).toBeCloseTo(freq('oop-root', 'check'), 3);
    expect(by['ip-vs-allin'].line).toBeCloseTo(freq('oop-root', 'allin'), 3);
    expect(by['oop-vs-bet33'].line).toBeCloseTo(freq('oop-root', 'check') * freq('ip-vs-check', 'bet33'), 3);
    expect(by['ip-vs-check'].line + by['ip-vs-allin'].line).toBeCloseTo(1, 3);
  });

  it('stores per-combo frequencies that sum to 1 and match the dump within 1/255', () => {
    const data = fixtureData();
    const combos = base64ToUint16(data.combos.ip);
    expect(combos.length).toBe(18);
    const node = data.nodes.find((n) => n.id === 'ip-vs-check');
    const bytes = base64ToBytes(node.freqs);
    const raw = dump.childrens.CHECK.strategy.strategy;
    const keys = Object.keys(raw);
    for (let c = 0; c < combos.length; c++) {
      const row = dequantizeRow(bytes, c * 3, 3);
      expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      let sum = 0;
      for (let a = 0; a < 3; a++) sum += bytes[c * 3 + a];
      expect(Math.abs(sum - 255)).toBeLessThanOrEqual(2);
    }
    for (const key of keys) {
      const [hi, lo] = parseCards(key);
      const i = Array.from(combos).findIndex((idx) => idx === (hi * (hi - 1)) / 2 + lo);
      raw[key].forEach((f, a) => expect(Math.abs(bytes[i * 3 + a] / 255 - f)).toBeLessThanOrEqual(1 / 255));
    }
  });

  it('quantises and encodes round-trip', () => {
    for (let k = 0; k <= 100; k++) expect(Math.abs(quantize(k / 100) / 255 - k / 100)).toBeLessThanOrEqual(0.5 / 255);
    expect(Array.from(base64ToUint16(uint16ToBase64([0, 1, 1325, 65535])))).toEqual([0, 1, 1325, 65535]);
  });
});

describe('flop library', () => {
  const data = fixtureData();
  const index = {
    version: 1,
    groups: TEXTURE_GROUPS,
    spots: [
      {
        id: 'srp-btn-bb',
        label: 'SRP BTN vs BB',
        ip: 'BTN',
        oop: 'BB',
        flops: [{ key: 'QsJh2h', group: 'Q/J-high wet', label: 'Q-high two-tone', weight: 10, raw: 100, nodes: data.nodes.map(({ id, label, player, actions, summary }) => ({ id, label, player, actions, summary })) }],
      },
    ],
  };
  beforeAll(() => {
    configureLibrary({ load: async (path) => (path === 'index.json' ? index : path === 'srp-btn-bb/QsJh2h.json' ? JSON.parse(JSON.stringify(data)) : null) });
  });

  it('finds the exact solved flop and maps suits', async () => {
    expect((await loadIndex()).spots).toHaveLength(1);
    const near = await nearestFlop('srp-btn-bb', 'QdJc2c');
    expect(near).toMatchObject({ key: 'QsJh2h', exact: true });
    expect(near.perm[1]).toBe(3); // diamonds → spades
    expect(near.perm[0]).toBe(2); // clubs → hearts (the flush suit)
  });

  it('follows the suit mapping for flush-draw combos', async () => {
    const stored = await strategyFor('srp-btn-bb', 'QsJh2h', 'ip-vs-check');
    const mapped = await strategyFor('srp-btn-bb', 'QdJc2c', 'ip-vs-check');
    // AhKh is a heart flush draw on QsJh2h; on QdJc2c the same hand is AcKc.
    expect(mapped.combos.get('AcKc').freqs).toEqual(stored.combos.get('AhKh').freqs);
    expect(mapped.combos.get('AhKh')).toBeUndefined();
    expect(mapped.exact).toBe(true);
    expect(mapped.classes.check.length).toBe(169);
  });

  it('falls back to the nearest texture with role-based suits', () => {
    const near = nearestAmong(['QsJh2h', 'AsKh2d'], 'KdTc3c');
    expect(near.exact).toBe(false);
    expect(near.key).toBe('QsJh2h');
    expect(near.perm[0]).toBe(2); // the real flush suit (clubs) maps to the stored flush suit (hearts)
    expect(nearestAmong([], 'KdTc3c')).toBeNull();
  });
});

describe('texture reports', () => {
  const node = (summary) => ({ id: 'ip-vs-check', actions: [{ key: 'check', label: 'Check' }, { key: 'bet33', label: 'Bet 33% (1.8bb)' }, { key: 'bet75', label: 'Bet 75% (4.1bb)' }], summary });
  const index = {
    spots: [
      {
        id: 's',
        flops: [
          { key: 'AsKh2d', group: 'A-high dry', raw: 300, nodes: [node([0.1, 0.8, 0.1])] },
          { key: 'AsQh7d', group: 'A-high dry', raw: 100, nodes: [node([0.3, 0.6, 0.1])] },
          { key: '7s5h4h', group: 'Low wet', raw: 200, nodes: [node([0.55, 0.15, 0.3])] },
        ],
      },
    ],
  };

  it('aggregates by texture group, weighted by real flop counts', () => {
    const r = textureReport(index, 's', 'ip-vs-check');
    expect(r.rows.map((x) => x.group)).toEqual(['A-high dry', 'Low wet']);
    expect(r.rows[0].freqs.bet33).toBeCloseTo((300 * 0.8 + 100 * 0.6) / 400, 12);
    expect(r.rows[0].share).toBeCloseTo(400 / 600, 12);
    expect(r.overall.freqs.check).toBeCloseTo((300 * 0.1 + 100 * 0.3 + 200 * 0.55) / 600, 12);
    expect(r.actions.map((a) => a.label)).toEqual(['Check', 'Bet 33%', 'Bet 75%']);
  });

  it('writes plain-language takeaways from the numbers', () => {
    const lines = takeaways(textureReport(index, 's', 'ip-vs-check'), 'BTN');
    expect(lines[0]).toBe('BTN bets 85% on A-high dry (mostly bet 33%), but only 45% on Low wet.');
    expect(lines.some((l) => /checks most on Low wet \(55%\)/.test(l))).toBe(true);
  });
});

describe('texture reports with rare lines', () => {
  const node = (summary, line) => ({ id: 'ip-vs-check', actions: [{ key: 'check', label: 'Check' }, { key: 'bet33', label: 'Bet 33%' }, { key: 'bet75', label: 'Bet 75%' }], summary, line });
  const flops = [
    { key: 'AsKh2d', group: 'A-high dry', raw: 300, nodes: [node([0.1, 0.8, 0.1], 0.5)] },
    { key: 'AsQh7d', group: 'A-high dry', raw: 100, nodes: [node([1, 0, 0], 0.002)] },
    { key: '7s5h4h', group: 'Low wet', raw: 200, nodes: [node([0.9, 0.05, 0.05], 0.01)] },
  ];

  it('counts each flop by how often the decision comes up there', () => {
    const r = textureReport({ spots: [{ id: 's', flops }] }, 's', 'ip-vs-check');
    expect(r.rows[0].reach).toBeCloseTo((300 * 0.5 + 100 * 0.002) / 400, 12);
    expect(r.rows[0].freqs.bet33).toBeCloseTo((150 * 0.8) / 150.2, 12);
    expect(r.rows[1].reach).toBeCloseTo(0.01, 12);
    expect(r.overall.reach).toBeCloseTo((150 + 0.2 + 2) / 600, 12);
  });

  it('leaves rare textures out of the takeaways and says so', () => {
    const lines = takeaways(textureReport({ spots: [{ id: 's', flops }] }, 's', 'ip-vs-check'), 'BTN');
    expect(lines.filter((l) => /Low wet/.test(l))).toEqual(['Left out because this decision rarely comes up there: Low wet (1%).']);
    const never = takeaways(textureReport({ spots: [{ id: 's', flops: [flops[2]] }] }, 's', 'ip-vs-check'), 'BTN');
    expect(never).toEqual(['This decision comes up only 1% of the time on these boards, so its mix tells you little.']);
  });
});

describe('flop trainer', () => {
  it('deals reproducibly from the library and scores like the preflop trainer', async () => {
    const index = await loadIndex();
    const q1 = await dealFlopQuestion(index, loadFlop, { rng: createRng(4) });
    const q2 = await dealFlopQuestion(index, loadFlop, { rng: createRng(4) });
    expect(cardsToString(q1.hand)).toBe(cardsToString(q2.hand));
    expect(q1.node.id).toBe(q2.node.id);
    expect(q1.frequencies.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(canonicalFlop(q1.board).key).toBe('QsJh2h');
    const best = scoreFlopAnswer(q1, q1.frequencies.indexOf(Math.max(...q1.frequencies)));
    expect(best.verdict).toBe('correct');
    const fake = { frequencies: [0.6, 0.25, 0.15, 0.0] };
    expect(scoreFlopAnswer(fake, 1).verdict).toBe('acceptable');
    expect(scoreFlopAnswer(fake, 2).verdict).toBe('acceptable');
    expect(scoreFlopAnswer(fake, 3).verdict).toBe('wrong');
    const stats = updateFlopStats({}, q1, 'wrong');
    expect(stats.spots['srp-btn-bb'].attempts).toBe(1);
    expect(stats.groups['Q/J-high wet'].wrong).toBe(1);
  });

  it('skips decisions that almost never come up', async () => {
    const index = await loadIndex();
    const rareLines = async (spotId, key) => {
      const d = await loadFlop(spotId, key);
      return { ...d, nodes: d.nodes.map((n) => ({ ...n, line: n.id === 'oop-root' ? 1 : 0.01 })) };
    };
    for (let seed = 1; seed <= 20; seed++) expect((await dealFlopQuestion(index, rareLines, { rng: createRng(seed) })).node.id).toBe('oop-root');
  });
});
