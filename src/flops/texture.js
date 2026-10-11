// Flop texture features, labels and report groups.
//
// Features: the three ranks high to low, suit pattern (rainbow / two-tone /
// monotone), pairing (unpaired / paired / trips), connectedness (all three ranks
// within a five-rank window, so a straight is possible; the ace also plays low),
// broadway count, and whether straight or flush draws exist.
// Labels read like "A-high dry rainbow" or "9-high connected monotone". Report groups
// are coarser: the high card bucket and dry (rainbow, unconnected) or wet (two-tone
// or connected), plus Paired high / Paired low, Trips and Monotone.

import { RANKS, parseCards } from '../engine/cards.js';

export const TEXTURE_GROUPS = [
  'A-high dry',
  'A-high wet',
  'K-high dry',
  'K-high wet',
  'Q/J-high dry',
  'Q/J-high wet',
  'Middle dry',
  'Middle wet',
  'Low dry',
  'Low wet',
  'Paired high',
  'Paired low',
  'Trips',
  'Monotone',
];

const RANK_T = 8;

/** True when all the given distinct ranks fit in a five-rank window (ace counts high or low). */
function inWindow(ranks) {
  const span = (rs) => Math.max(...rs) - Math.min(...rs);
  if (span(ranks) <= 4) return true;
  if (ranks.includes(12)) return span(ranks.map((r) => (r === 12 ? -1 : r))) <= 4;
  return false;
}

/** Texture features of a flop (card indices or a string). */
export function flopFeatures(input) {
  const cards = (typeof input === 'string' ? parseCards(input) : input.slice()).sort((a, b) => b - a);
  if (cards.length !== 3) throw new Error('A flop has exactly 3 cards');
  const ranks = cards.map((c) => c >> 2).sort((a, b) => b - a);
  const suitCounts = [0, 0, 0, 0];
  for (const c of cards) suitCounts[c & 3]++;
  const maxSuit = Math.max(...suitCounts);
  const suitPattern = maxSuit === 3 ? 'monotone' : maxSuit === 2 ? 'two-tone' : 'rainbow';
  const distinct = [...new Set(ranks)];
  const pairing = distinct.length === 3 ? 'unpaired' : distinct.length === 2 ? 'paired' : 'trips';
  const connected = distinct.length === 3 && inWindow(distinct);
  let closePairs = 0;
  for (let i = 0; i < distinct.length; i++) for (let j = i + 1; j < distinct.length; j++) if (inWindow([distinct[i], distinct[j]])) closePairs++;
  const pairRank = pairing === 'unpaired' ? null : ranks[1];
  return {
    ranks,
    high: ranks[0],
    middle: ranks[1],
    low: ranks[2],
    suitPattern,
    pairing,
    pairRank,
    connected,
    straightDraws: closePairs > 0,
    closePairs,
    flushPossible: suitPattern === 'monotone',
    flushDraw: suitPattern === 'two-tone',
    broadways: ranks.filter((r) => r >= RANK_T).length,
    dry: suitPattern === 'rainbow' && !connected && pairing === 'unpaired',
  };
}

/** Readable label, e.g. 'A-high dry rainbow', '9-high connected monotone', '7-high paired rainbow'. */
export function textureLabel(input) {
  const f = input.ranks ? input : flopFeatures(input);
  const words = [`${RANKS[f.high]}-high`];
  if (f.pairing !== 'unpaired') words.push(f.pairing);
  if (f.connected) words.push('connected');
  if (f.dry) words.push('dry');
  words.push(f.suitPattern);
  return words.join(' ');
}

function highBucket(rank) {
  if (rank === 12) return 'A-high';
  if (rank === 11) return 'K-high';
  if (rank >= 9) return 'Q/J-high';
  if (rank >= 6) return 'Middle';
  return 'Low';
}

/** Report group, one of TEXTURE_GROUPS. */
export function textureGroup(input) {
  const f = input.ranks ? input : flopFeatures(input);
  if (f.suitPattern === 'monotone') return 'Monotone';
  if (f.pairing === 'trips') return 'Trips';
  if (f.pairing === 'paired') return f.pairRank >= RANK_T ? 'Paired high' : 'Paired low';
  return `${highBucket(f.high)} ${f.dry ? 'dry' : 'wet'}`;
}

/**
 * Distance between two flops' textures, used to pick representatives and to find
 * the nearest solved flop. Ranks dominate within a group; suit pattern, pairing and
 * connectedness differences cost more.
 */
export function textureDistance(a, b) {
  const fa = a.ranks ? a : flopFeatures(a);
  const fb = b.ranks ? b : flopFeatures(b);
  let d = Math.abs(fa.high - fb.high) * 1.2 + Math.abs(fa.middle - fb.middle) + Math.abs(fa.low - fb.low) * 0.8;
  if (fa.suitPattern !== fb.suitPattern) d += 6;
  if (fa.pairing !== fb.pairing) d += 12;
  if (fa.connected !== fb.connected) d += 3;
  d += Math.abs(fa.closePairs - fb.closePairs) * 1.5;
  d += Math.abs(fa.broadways - fb.broadways) * 0.7;
  return d;
}
