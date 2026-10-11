// Flop library: loads the pre-solved flop data (data/flops/) and maps any real flop
// onto a stored strategy, with suits translated back to the real board.
//
// - canonicalFlop(cards): suit-isomorphic canonical form and suit permutation.
// - nearestFlop(spotId, cards): the stored flop for a real board, exact when its
//   canonical form was solved, otherwise the nearest solved flop by texture (its
//   subset representative when solved). Suits are mapped real → stored: by the
//   canonical permutation for exact matches, and by suit role (how many board cards a
//   suit has, then its highest card) for nearest flops, so flush suits map to flush
//   suits and flush draws keep their meaning.
// - strategyFor(spotId, cards, nodeId): per-combo and per-class frequencies in real suits.

import subset from '../../data/flops/subset.json' with { type: 'json' };
import { canonicalFlop, mapCard, invertPerm } from './canonical.js';
import { flopFeatures, textureLabel, textureGroup, textureDistance } from './texture.js';
import { base64ToBytes, base64ToUint16, dequantizeRow, QMAX } from './codec.js';
import { parseCards, cardToString } from '../engine/cards.js';
import { COMBO_CARDS, COMBO_CLASS } from '../engine/combos.js';
import { handClasses } from '../engine/ranges.js';

export { canonicalFlop };

const CLASSES = handClasses();
// The data folder sits next to the source in Node and the dev server; a build gets a copy
// at <base>/data/flops/ (vite.config.js). The path is kept out of a literal
// new URL('...', import.meta.url), which Vite would turn into one bundled asset.
const DATA_DIR = '../../data/flops/';
const DATA_URL = import.meta.env?.PROD
  ? new URL(`${import.meta.env.BASE_URL}data/flops/`, globalThis.location.href)
  : new URL(DATA_DIR, import.meta.url);
const EMPTY_INDEX = { version: 1, groups: [], spots: [] };

const representativeOf = new Map();
for (const rep of subset.representatives) for (const key of rep.members) representativeOf.set(key, rep.key);

/** Default JSON loader: fs in Node, fetch in browsers. Resolves null when the file is missing. */
async function defaultLoad(relativePath) {
  const url = new URL(relativePath, DATA_URL);
  const fs = globalThis.process?.getBuiltinModule?.('node:fs');
  if (fs && url.protocol === 'file:') return fs.existsSync(url) ? JSON.parse(fs.readFileSync(url, 'utf8')) : null;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load ${relativePath} (${res.status})`);
  return res.json();
}

let loadJSON = defaultLoad;
let indexPromise = null;
const flopCache = new Map();

/** Replaces the data loader (tests point it at fixtures) and clears the caches. */
export function configureLibrary({ load } = {}) {
  loadJSON = load ?? defaultLoad;
  indexPromise = null;
  flopCache.clear();
}

/** data/flops/index.json (spots, solved flops, summaries); empty when nothing is solved yet. */
export function loadIndex() {
  indexPromise ??= loadJSON('index.json').then((x) => x ?? EMPTY_INDEX);
  return indexPromise;
}

/** Decodes a flop file once: combo lists, range weights, per-node frequencies and reach. */
function decodeFlop(raw) {
  const combos = { oop: base64ToUint16(raw.combos.oop), ip: base64ToUint16(raw.combos.ip) };
  const weights = {
    oop: Float64Array.from(base64ToBytes(raw.weights.oop), (b) => b / QMAX),
    ip: Float64Array.from(base64ToBytes(raw.weights.ip), (b) => b / QMAX),
  };
  const nodes = raw.nodes.map((n) => ({ ...n, bytes: base64ToBytes(n.freqs) }));
  const root = nodes.find((n) => n.id === 'oop-root');
  const checkAt = root ? root.actions.findIndex((a) => a.key === 'check') : -1;
  for (const n of nodes) {
    const list = combos[n.player];
    n.reach = Float64Array.from(list, (_, c) => {
      let w = weights[n.player][c];
      if (n.player === 'oop' && n.id.startsWith('oop-vs-') && root && checkAt >= 0) {
        w *= dequantizeRow(root.bytes, c * root.actions.length, root.actions.length)[checkAt];
      }
      return w;
    });
  }
  return { ...raw, combos, weights, nodes };
}

/** Decoded data for a stored flop (canonical key), cached; null when not solved. */
export async function loadFlop(spotId, flopKey) {
  const id = `${spotId}/${flopKey}`;
  if (!flopCache.has(id)) {
    flopCache.set(
      id,
      loadJSON(`${spotId}/${flopKey}.json`).then((raw) => (raw ? decodeFlop(raw) : null)),
    );
  }
  return flopCache.get(id);
}

/** Suits ordered by role on a board: most cards first, then highest card. */
function suitRoles(cards) {
  const info = [0, 1, 2, 3].map((s) => {
    const ranks = cards.filter((c) => (c & 3) === s).map((c) => c >> 2).sort((a, b) => b - a);
    return { s, count: ranks.length, ranks };
  });
  info.sort((a, b) => b.count - a.count || (b.ranks[0] ?? -1) - (a.ranks[0] ?? -1) || (b.ranks[1] ?? -1) - (a.ranks[1] ?? -1) || a.s - b.s);
  return info.map((x) => x.s);
}

/** Suit permutation real → stored that lines up suits by role (perm[realSuit] = storedSuit). */
export function suitRoleMap(realCards, storedCards) {
  const real = suitRoles(realCards);
  const stored = suitRoles(storedCards);
  const perm = [0, 0, 0, 0];
  real.forEach((s, i) => {
    perm[s] = stored[i];
  });
  return perm;
}

/**
 * Pure version of nearestFlop: picks among `solvedKeys` (canonical keys).
 * Returns { key, exact, perm (real → stored suits), label, group, distance } or null.
 */
export function nearestAmong(solvedKeys, input) {
  const cards = typeof input === 'string' || Array.isArray(input) ? parseCards(input) : input;
  if (!solvedKeys.length) return null;
  const solved = new Set(solvedKeys);
  const canon = canonicalFlop(cards);
  const describe = (key) => {
    const f = flopFeatures(key);
    return { label: textureLabel(f), group: textureGroup(f) };
  };
  if (solved.has(canon.key)) return { key: canon.key, exact: true, perm: canon.perm, distance: 0, ...describe(canon.key) };
  const rep = representativeOf.get(canon.key);
  let key = rep && solved.has(rep) ? rep : null;
  if (!key) {
    const target = flopFeatures(canon.cards);
    const group = textureGroup(target);
    let best = Infinity;
    for (const k of solvedKeys) {
      const f = flopFeatures(k);
      const d = textureDistance(target, f) + (textureGroup(f) === group ? 0 : 20);
      if (d < best) {
        best = d;
        key = k;
      }
    }
  }
  return {
    key,
    exact: false,
    perm: suitRoleMap(cards, parseCards(key)),
    distance: textureDistance(canon.cards, parseCards(key)),
    ...describe(key),
  };
}

/** The stored flop for a real board in a spot (see nearestAmong), or null if the spot has no data. */
export async function nearestFlop(spotId, cards) {
  const index = await loadIndex();
  const spot = index.spots.find((s) => s.id === spotId);
  return nearestAmong(spot ? spot.flops.map((f) => f.key) : [], cards);
}

/**
 * Strategy at a node for a real board: { exact, flop, label, node, actions, summary, line,
 * combos: Map('AhKh' → { cards, freqs, weight }), classes: { [actionKey]: Float64Array(169) },
 * classWeights: Float64Array(169) }. Frequencies are in real suits; for a nearest flop,
 * stored combos that clash with the real board are left out. Class frequencies average
 * the combos weighted by the player's reach at the node.
 */
export async function strategyFor(spotId, input, nodeId) {
  const cards = typeof input === 'string' || Array.isArray(input) ? parseCards(input) : input;
  const near = await nearestFlop(spotId, cards);
  if (!near) return null;
  const data = await loadFlop(spotId, near.key);
  if (!data) return null;
  const node = data.nodes.find((n) => n.id === nodeId) ?? data.nodes[0];
  const toReal = invertPerm(near.perm);
  const board = new Set(cards);
  const list = data.combos[node.player];
  const k = node.actions.length;
  const combos = new Map();
  const sums = node.actions.map(() => new Float64Array(169));
  const classWeights = new Float64Array(169);
  list.forEach((idx, c) => {
    const a = mapCard(COMBO_CARDS[2 * idx], toReal);
    const b = mapCard(COMBO_CARDS[2 * idx + 1], toReal);
    if (board.has(a) || board.has(b)) return;
    const freqs = dequantizeRow(node.bytes, c * k, k);
    const weight = node.reach[c];
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    combos.set(cardToString(hi) + cardToString(lo), { cards: [hi, lo], freqs, weight });
    const cls = COMBO_CLASS[idx];
    classWeights[cls] += weight;
    freqs.forEach((f, i) => {
      sums[i][cls] += weight * f;
    });
  });
  const classes = {};
  node.actions.forEach((action, i) => {
    classes[action.key] = Float64Array.from(sums[i], (s, cls) => (classWeights[cls] > 0 ? s / classWeights[cls] : 0));
  });
  return {
    exact: near.exact,
    flop: near.key,
    label: near.label,
    group: near.group,
    perm: near.perm,
    node: { id: node.id, label: node.label, player: node.player },
    nodes: data.nodes.map((n) => ({ id: n.id, label: n.label, player: n.player, line: n.line ?? 1 })),
    actions: node.actions,
    summary: node.summary,
    line: node.line ?? 1,
    combos,
    classes,
    classWeights,
    classNames: CLASSES,
  };
}
