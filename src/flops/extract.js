// Turns TexasSolver output into compact flop study data, and reads its progress log.
//
// TexasSolver's dump (checked against a real solve) is a tree of nodes:
//   { node_type: 'action_node', player, actions: ['CHECK', 'BET 18.000000', ...],
//     strategy: { actions, strategy: { '<combo>': [freq per action] } },
//     childrens: { '<action label>': node } }
// with chance nodes ({ node_type: 'chance_node' }) where later streets begin. Player 1
// is OOP (it acts first) and player 0 is IP. Combo keys name the higher card first
// ('AhKh', '2d2c'). BET / RAISE amounts are the chips that action adds, so a raise
// over a bet is "raise to" its amount when the raiser had nothing in yet.

import { parseCards } from '../engine/cards.js';
import { comboIndex, COMBO_CLASS } from '../engine/combos.js';
import { quantize, bytesToBase64, uint16ToBase64 } from './codec.js';
import { TREE } from './tree-config.js';

export const DATA_VERSION = 1;

/**
 * Progress from TexasSolver's console output: { iterations, exploitability (% of pot),
 * timeUsed (s), history }. Accepts text or a Buffer, UTF-8 or UTF-16 (PowerShell's
 * `*>` writes UTF-16).
 */
export function parseSolverLog(input) {
  let text;
  if (typeof input === 'string') text = input;
  else if (input[0] === 0xff && input[1] === 0xfe) text = new TextDecoder('utf-16le').decode(input);
  else text = new TextDecoder('utf-8').decode(input);
  text = text.replace(/\u0000/g, '');
  const history = [];
  const re = /Iter:\s*(\d+)[\s\S]*?Total exploitability\s+(-?[\d.]+(?:e[-+]?\d+)?)\s+precent(?:[\s\S]*?time used:\s*([\d.]+))?/g;
  let m;
  while ((m = re.exec(text))) {
    history.push({ iteration: Number(m[1]), exploitability: Number(m[2]), time: m[3] !== undefined ? Number(m[3]) : null });
  }
  const last = history[history.length - 1];
  return {
    iterations: last?.iteration ?? null,
    exploitability: last ? Math.round(last.exploitability * 1000) / 1000 : null,
    timeUsed: last?.time ?? null,
    history,
  };
}

/** 'BET 18.000000' → { type: 'bet', chips: 18 }; 'CHECK' → { type: 'check', chips: null } */
export function parseActionLabel(label) {
  const m = /^(CHECK|CALL|FOLD|BET|RAISE|ALLIN)(?:\s+(-?[\d.]+))?$/i.exec(String(label).trim());
  if (!m) return { type: 'unknown', chips: null, raw: label };
  return { type: m[1].toLowerCase(), chips: m[2] !== undefined ? Number(m[2]) : null };
}

/** Configured size (%) closest to a bet of `chips` into `potChips`, or the rounded %. */
function sizeKey(chips, potChips, configured) {
  const pct = (chips / potChips) * 100;
  const near = configured.reduce((best, s) => (Math.abs(s - pct) < Math.abs(best - pct) ? s : best), configured[0] ?? Math.round(pct));
  return Math.abs(near - pct) <= 3 ? near : Math.round(pct);
}

/** Action descriptors for a node: [{ key, type, label, bb, potFraction?, allin }] */
function describeActions(labels, { potChips, stackChips, scale, betSizes }) {
  return labels.map((label) => {
    const { type, chips } = parseActionLabel(label);
    const bb = chips === null ? null : chips / scale;
    const allin = chips !== null && chips >= stackChips - 0.5;
    if (type === 'bet') {
      if (allin) return { key: 'allin', type: 'bet', label: `All-in (${bb}bb)`, bb, allin: true };
      const pct = sizeKey(chips, potChips, betSizes);
      return { key: `bet${pct}`, type: 'bet', label: `Bet ${pct}% (${bb}bb)`, bb, potFraction: chips / potChips, allin: false };
    }
    if (type === 'raise') return { key: allin ? 'allin' : 'raise', type: 'raise', label: allin ? `All-in (${bb}bb)` : `Raise to ${bb}bb`, bb, allin };
    const names = { check: 'Check', call: 'Call', fold: 'Fold' };
    return { key: type, type, label: names[type] ?? label, bb, allin: false };
  });
}

/** The flop decisions worth studying: [{ id, player, kind, node, betKey? }] */
function studyNodes(root, ctx) {
  const out = [];
  const expect = (node, player, where) => {
    if (node?.node_type !== 'action_node') throw new Error(`Expected a decision at ${where}`);
    if (node.player !== player) throw new Error(`Expected player ${player} (${player === 1 ? 'OOP' : 'IP'}) at ${where}, got ${node.player}`);
    return node;
  };
  out.push({ id: 'oop-root', player: 'oop', kind: 'first', node: expect(root, 1, 'the root') });
  const children = root.childrens ?? {};
  for (const [label, child] of Object.entries(children)) {
    const { type, chips } = parseActionLabel(label);
    if (type === 'check' && child.node_type === 'action_node') {
      out.push({ id: 'ip-vs-check', player: 'ip', kind: 'vsCheck', node: expect(child, 0, 'IP after a check') });
      for (const [betLabel, facing] of Object.entries(child.childrens ?? {})) {
        const bet = parseActionLabel(betLabel);
        if (bet.type !== 'bet' || facing.node_type !== 'action_node') continue;
        const key = bet.chips >= ctx.stackChips - 0.5 ? 'allin' : `bet${sizeKey(bet.chips, ctx.potChips, ctx.tree.flop.ipBet)}`;
        out.push({ id: `oop-vs-${key}`, player: 'oop', kind: 'vsBet', betKey: key, betChips: bet.chips, via: betLabel, node: expect(facing, 1, `OOP facing ${betLabel}`) });
      }
    } else if (type === 'bet' && child.node_type === 'action_node') {
      const sizes = ctx.tree.flop.oopBet[ctx.spot.type] ?? [];
      const key = chips >= ctx.stackChips - 0.5 ? 'allin' : `bet${sizeKey(chips, ctx.potChips, sizes.length ? sizes : [Math.round((chips / ctx.potChips) * 100)])}`;
      out.push({ id: `ip-vs-${key}`, player: 'ip', kind: 'vsBet', betKey: key, betChips: chips, via: label, node: expect(child, 0, `IP facing ${label}`) });
    }
  }
  // The solver's child order varies, so fix one: the check line first (OOP, IP vs check,
  // OOP vs each bet from small to big), then IP facing a lead.
  const rank = (item) => (item.kind === 'first' ? 0 : item.kind === 'vsCheck' ? 1 : item.player === 'oop' ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b) || (a.betChips ?? 0) - (b.betChips ?? 0));
}

function nodeLabel(item, spot, ctx) {
  const actor = item.player === 'oop' ? spot.oop : spot.ip;
  const other = item.player === 'oop' ? spot.ip : spot.oop;
  if (item.kind === 'first') return `${actor} first action`;
  if (item.kind === 'vsCheck') return `${actor} vs check`;
  const size = item.betKey === 'allin' ? 'all-in' : `${item.betKey.slice(3)}% bet (${item.betChips / ctx.tree.scale}bb)`;
  return `${actor} vs ${other} ${size}`;
}

/**
 * Compact study data for one solved flop.
 * dump: parsed TexasSolver output; spot: resolved spot (spots.js); flop: canonical key.
 * Combos per player are those in the dump, sorted by combo index; per-node frequencies
 * are quantised to 0-255, combo-major (combo 0's actions, then combo 1's ...).
 * summary = each action's frequency over the player's range at that node, weighting
 * combos by preflop range weight and, for OOP facing a bet, by how often it checked.
 * line = how often the decision comes up at all: 1 for the first action, OOP's check
 * frequency for IP vs check, check × IP's bet frequency for OOP facing that bet, OOP's
 * lead frequency for IP facing a lead (range-weighted; card removal between the two
 * ranges is ignored). Lines that almost never come up have barely-tested strategies.
 */
export function extractFlop({ dump, spot, flop, solve = null, tree = TREE }) {
  const ctx = { spot, tree, potChips: spot.pot * tree.scale, stackChips: spot.stack * tree.scale };
  const items = studyNodes(dump, ctx);
  const playerCombos = {};
  const keyOf = {};
  for (const player of ['oop', 'ip']) {
    const first = items.find((x) => x.player === player);
    const keys = first ? Object.keys(first.node.strategy.strategy) : [];
    const entries = keys.map((k) => {
      const [a, b] = parseCards(k);
      return [comboIndex(a, b), k];
    });
    entries.sort((x, y) => x[0] - y[0]);
    playerCombos[player] = entries.map((e) => e[0]);
    keyOf[player] = entries.map((e) => e[1]);
  }
  const weightOf = (player, idx) => spot.ranges[player][COMBO_CLASS[idx]];
  const root = items.find((x) => x.id === 'oop-root');
  const rootCheck = root.node.strategy.actions.findIndex((label) => parseActionLabel(label).type === 'check');

  const raw = items.map((item) => {
    const labels = item.node.strategy.actions;
    const actions = describeActions(labels, { ...ctx, scale: tree.scale, betSizes: item.kind === 'vsCheck' ? tree.flop.ipBet : tree.flop.oopBet[spot.type] ?? [] });
    const combos = playerCombos[item.player];
    const freqs = new Uint8Array(combos.length * labels.length);
    const summary = new Array(labels.length).fill(0);
    let reachTotal = 0;
    let missing = 0;
    combos.forEach((idx, c) => {
      const row = item.node.strategy.strategy[keyOf[item.player][c]];
      if (!row) {
        missing++;
        return;
      }
      let reach = weightOf(item.player, idx);
      if (item.player === 'oop' && item.kind === 'vsBet' && rootCheck >= 0) {
        reach *= root.node.strategy.strategy[keyOf.oop[c]]?.[rootCheck] ?? 0;
      }
      reachTotal += reach;
      row.forEach((f, a) => {
        freqs[c * labels.length + a] = quantize(f);
        summary[a] += reach * f;
      });
    });
    return {
      id: item.id,
      player: item.player,
      label: nodeLabel(item, spot, ctx),
      actions,
      freqs: bytesToBase64(freqs),
      summary: summary.map((x) => (reachTotal ? x / reachTotal : 0)),
      ...(missing ? { missingCombos: missing } : {}),
    };
  });

  const freqOf = (id, label) => {
    const i = items.findIndex((x) => x.id === id);
    const at = i >= 0 ? items[i].node.strategy.actions.indexOf(label) : -1;
    return at >= 0 ? raw[i].summary[at] : 0;
  };
  const checkLabel = rootCheck >= 0 ? root.node.strategy.actions[rootCheck] : null;
  const checks = checkLabel ? freqOf('oop-root', checkLabel) : 0;
  const lineOf = (item) => {
    if (item.kind === 'first') return 1;
    if (item.kind === 'vsCheck') return checks;
    return item.player === 'oop' ? checks * freqOf('ip-vs-check', item.via) : freqOf('oop-root', item.via);
  };
  const round = (x) => Math.round(x * 1e4) / 1e4;
  const nodes = raw.map((n, i) => ({ ...n, summary: n.summary.map(round), line: round(lineOf(items[i])) }));

  return {
    version: DATA_VERSION,
    spot: spot.id,
    flop,
    pot: spot.pot,
    stack: spot.stack,
    players: { oop: spot.oop, ip: spot.ip },
    combos: { oop: uint16ToBase64(playerCombos.oop), ip: uint16ToBase64(playerCombos.ip) },
    weights: {
      oop: bytesToBase64(Uint8Array.from(playerCombos.oop, (i) => quantize(weightOf('oop', i)))),
      ip: bytesToBase64(Uint8Array.from(playerCombos.ip, (i) => quantize(weightOf('ip', i)))),
    },
    nodes,
    ...(solve ? { solve } : {}),
  };
}
