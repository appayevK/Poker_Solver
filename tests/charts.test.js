import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadChart,
  saveChart,
  listCharts,
  deleteChart,
  duplicateChart,
  validateChart,
  chartWarnings,
  chartAction,
  spotRange,
  spotFrequencies,
  diffCharts,
  setSpotAction,
  allSpotIds,
  parseSpotId,
  spotIdProblem,
  legalActions,
  BASELINE_ID,
} from '../src/preflop/charts.js';
import { defendCheck, bluffCheck, blockerEffect, spotSizes } from '../src/preflop/checks.js';
import { rangePercent } from '../src/engine/ranges.js';

// Minimal in-memory localStorage so saved charts can round-trip in Node.
function installStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}

const baseline = loadChart(BASELINE_ID);
const rfiShare = (pos) => rangePercent(spotRange(baseline, `RFI:${pos}`, 'raise'));

describe('chart format', () => {
  it('parses and checks spot ids', () => {
    expect(parseSpotId('vsOpen:BB:BTN')).toEqual({ type: 'vsOpen', hero: 'BB', villain: 'BTN' });
    expect(parseSpotId('RFI:CO')).toEqual({ type: 'RFI', hero: 'CO', villain: null });
    expect(spotIdProblem('RFI:CO')).toBe('');
    expect(spotIdProblem('RFI:BB')).toMatch(/BB cannot open/);
    expect(spotIdProblem('vsOpen:UTG:CO')).toMatch(/must act before/);
    expect(spotIdProblem('vs3bet:BTN:CO')).toMatch(/must act after/);
    expect(spotIdProblem('vsOpen:BB:XX')).toMatch(/unknown position/);
    expect(spotIdProblem('Open:BB')).toMatch(/not a spot id/);
    expect(allSpotIds()).toHaveLength(5 + 15 + 15);
  });

  it('lists legal actions per spot', () => {
    expect(legalActions(baseline, 'RFI:UTG')).toEqual(['fold', 'raise']);
    expect(legalActions(baseline, 'vsOpen:BB:BTN')).toEqual(['fold', 'call', 'raise']);
  });
});

describe('baseline chart', () => {
  it('passes validateChart and covers every 6-max spot', () => {
    expect(validateChart(baseline)).toEqual([]);
    expect(chartWarnings(baseline)).toEqual([]);
    for (const id of allSpotIds()) expect(baseline.spots[id], id).toBeDefined();
    expect(baseline.notes).toMatch(/not solver output/);
  });

  it('opens within the target widths and wider by position', () => {
    const bounds = { UTG: [0.15, 0.18], HJ: [0.19, 0.23], CO: [0.26, 0.31], BTN: [0.42, 0.5], SB: [0.38, 0.46] };
    for (const [pos, [lo, hi]] of Object.entries(bounds)) {
      expect(rfiShare(pos), pos).toBeGreaterThanOrEqual(lo);
      expect(rfiShare(pos), pos).toBeLessThanOrEqual(hi);
    }
    expect(rfiShare('UTG')).toBeLessThan(rfiShare('HJ'));
    expect(rfiShare('HJ')).toBeLessThan(rfiShare('CO'));
    expect(rfiShare('CO')).toBeLessThan(rfiShare('BTN'));
  });

  it('never folds AA, KK, QQ or AKs, and always folds 72o', () => {
    for (const id of Object.keys(baseline.spots)) {
      for (const hand of ['AA', 'KK', 'QQ', 'AKs']) expect(chartAction(baseline, id, hand).fold, `${hand} in ${id}`).toBe(0);
      expect(chartAction(baseline, id, '72o').fold, `72o in ${id}`).toBe(1);
    }
  });

  it('defends widest in the BB vs late opens, and the SB mostly 3-bets or folds', () => {
    const defend = (id) => defendCheck(baseline, id).defend;
    expect(defend('vsOpen:BB:BTN')).toBeGreaterThan(defend('vsOpen:BB:CO'));
    expect(defend('vsOpen:BB:CO')).toBeGreaterThan(defend('vsOpen:BB:UTG'));
    expect(defend('vsOpen:BB:SB')).toBeGreaterThan(defend('vsOpen:BB:CO'));
    for (const opener of ['UTG', 'HJ', 'CO', 'BTN']) {
      expect(defendCheck(baseline, `vsOpen:SB:${opener}`).call).toBe(0);
    }
  });

  it('continues vs a 3-bet only with hands that were opened', () => {
    for (const id of Object.keys(baseline.spots).filter((x) => x.startsWith('vs3bet'))) {
      const opener = parseSpotId(id).hero;
      const opens = spotFrequencies(baseline, `RFI:${opener}`);
      const cont = spotFrequencies(baseline, id);
      for (let c = 0; c < 169; c++) expect(cont.raise[c] + cont.call[c] + cont.allin[c]).toBeLessThanOrEqual(opens.raise[c] + 1e-9);
    }
  });
});

describe('chart helpers', () => {
  it('chartAction returns frequencies summing to 1, with mixed weights', () => {
    for (const hand of ['AA', 'A5s', 'K9s', '72o', 'JJ', 'AsKd']) {
      const f = chartAction(baseline, 'vsOpen:BB:BTN', hand);
      expect(f.raise + f.call + f.allin + f.fold).toBeCloseTo(1, 12);
    }
    expect(chartAction(baseline, 'vsOpen:BB:BTN', 'K9s')).toEqual({ raise: 0.25, call: 0.75, allin: 0, fold: 0 });
    expect(chartAction(baseline, 'RFI:CO', 'A8o')).toEqual({ raise: 0.5, call: 0, allin: 0, fold: 0.5 });
  });

  it('validateChart catches sums above 1, bad ranges and bad spot ids', () => {
    const bad = duplicateChart(baseline);
    bad.spots['RFI:CO'] = { raise: 'AA, KK', call: 'AA:0.5' };
    bad.spots['vsOpen:BB:BTN'] = { raise: 'QQ+, ZZ' };
    bad.spots['vsOpen:UTG:BTN'] = { raise: 'AA' };
    bad.spots['RFI:HJ'] = { fold: 'AA' };
    const problems = validateChart(bad);
    expect(problems.some((p) => p.startsWith('RFI:CO') && /more than 1 for AA/.test(p))).toBe(true);
    expect(problems.some((p) => p.startsWith('vsOpen:BB:BTN.raise') && /ZZ/.test(p))).toBe(true);
    expect(problems.some((p) => /vsOpen:UTG:BTN/.test(p) && /must act before/.test(p))).toBe(true);
    expect(problems.some((p) => p.startsWith('RFI:HJ') && /unknown action "fold"/.test(p))).toBe(true);
    expect(validateChart({})).toContain('Chart needs an id');
  });

  it('warns, without blocking a save, about continuing vs a 3-bet with a hand that was not opened', () => {
    const bad = duplicateChart(baseline);
    bad.spots['vs3bet:UTG:BTN'].call += ', 72o';
    expect(chartWarnings(bad).some((p) => /does not open \(72o\)/.test(p))).toBe(true);
    expect(validateChart(bad)).toEqual([]);
  });

  it('diffCharts finds exactly the changed classes', () => {
    const edited = duplicateChart(baseline);
    setSpotAction(edited, 'vsOpen:BB:BTN', 'call', `${edited.spots['vsOpen:BB:BTN'].call}, 72o, 32o:0.5`);
    setSpotAction(edited, 'vsOpen:BB:BTN', 'raise', edited.spots['vsOpen:BB:BTN'].raise.replace('A5s, ', ''));
    const diff = diffCharts(baseline, edited, 'vsOpen:BB:BTN');
    expect(diff.map((d) => d.handClass).sort()).toEqual(['32o', '72o', 'A5s'].sort());
    expect(diff.find((d) => d.handClass === '72o').b.call).toBe(1);
    expect(diffCharts(baseline, baseline, 'RFI:BTN')).toEqual([]);
  });
});

describe('chart storage', () => {
  beforeEach(installStorage);

  it('round-trips a duplicated, edited chart', () => {
    const copy = duplicateChart(loadChart(BASELINE_ID), { name: 'My chart' });
    setSpotAction(copy, 'RFI:UTG', 'raise', 'QQ+, AKs');
    saveChart(copy);
    expect(listCharts().map((c) => c.name)).toEqual(['6-max 100bb baseline', 'My chart']);
    const back = loadChart(copy.id);
    expect(back).toEqual(copy);
    expect(chartAction(back, 'RFI:UTG', 'JJ').fold).toBe(1);
    deleteChart(copy.id);
    expect(loadChart(copy.id)).toBeNull();
    expect(listCharts()).toHaveLength(1);
  });

  it('keeps the baseline read-only and refuses invalid charts', () => {
    expect(() => saveChart(loadChart(BASELINE_ID))).toThrow(/read-only/);
    const bad = duplicateChart(baseline);
    bad.spots['RFI:CO'] = { raise: 'AA', call: 'AA' };
    expect(() => saveChart(bad)).toThrow(/problems/);
    expect(() => deleteChart(BASELINE_ID)).toThrow();
  });
});

describe('range checks', () => {
  it('compares defence with MDF', () => {
    const d = defendCheck(baseline, 'vsOpen:BB:BTN');
    expect(d.mdf).toBeCloseTo(1.5 / 4, 12);
    expect(d.defend).toBeCloseTo(d.threeBet + d.call, 12);
    expect(d.defend).toBeGreaterThan(d.mdf);
    // an SB open of 3bb adds 2.5bb to the 0.5bb it posted
    expect(defendCheck(baseline, 'vsOpen:BB:SB').bet).toBe(2.5);
  });

  it('computes bluff break-even fold frequencies and the chart fold share', () => {
    const b = bluffCheck(baseline, 'vsOpen:BTN:CO');
    expect(b.size).toBe(7.5);
    expect(b.breakEven).toBeCloseTo(7.5 / (4 + 7.5), 12);
    expect(b.opponentFolds).toBeGreaterThan(0.4);
    expect(b.opponentFolds).toBeLessThan(0.8);
    const four = bluffCheck(baseline, 'vs3bet:CO:BTN');
    expect(four.size).toBeCloseTo(16.5, 12);
    expect(four.opponentFolds).toBeNull();
    expect(spotSizes(baseline, 'vsOpen:BB:BTN').threeBet).toBe(10);
  });

  it('describes blocker effects', () => {
    const e = blockerEffect(baseline, 'vsOpen:BTN:CO', 'A5s');
    expect(e.foldShareWith).toBeGreaterThan(e.foldShareAverage);
    expect(e.blocks[0]).toEqual({ handClass: 'AA', remaining: 3, total: 6, weight: 1 });
    expect(e.blocks.find((x) => x.handClass === 'AKo').remaining).toBe(9);
  });
});
