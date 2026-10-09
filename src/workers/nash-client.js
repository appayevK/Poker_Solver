// Promise-based access to the Nash push/fold worker, with a solution cache.
//
//   const solution = await solveNash({ method: 'table', stacks: [15, 15, 15] }, { onProgress });
//
// Solutions are cached in localStorage (src/storage/store.js) under a hash of the
// parameters, so the same spot opens instantly the second time. The cache keeps the
// most recent CACHE_LIMIT solutions.

import { load, save } from '../storage/store.js';
import { strategyToRange } from '../nash/pushfold.js';

const CACHE_VERSION = 2;
const CACHE_LIMIT = 10;
const INDEX_KEY = 'nash:index';

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./nash.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (data.progress) {
      job.onProgress?.(data.progress);
      return;
    }
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.result);
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    failAll(new Error(event.message || 'Nash worker failed'));
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function failAll(err) {
  for (const job of pending.values()) job.reject(err);
  pending.clear();
}

/** JSON with object keys sorted, so equal parameters always give the same string. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined && typeof value[k] !== 'function')
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a 32-bit hash as hex. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Cache key for a solve request. */
export function nashCacheKey(method, params) {
  return `nash:${CACHE_VERSION}:${hash(stableStringify({ method, params }))}`;
}

const round = (digits) => (x) => Number(x.toFixed(digits));

/** Compact, JSON-friendly copy of a solution (range Maps are rebuilt on load). */
export function serializeSolution(solution) {
  const { seats, nodes, evs, sbJam, bbCall, ...rest } = solution;
  return {
    ...rest,
    seats: seats.map(({ seat, position, stack }) => ({ seat, position, stack })),
    nodes: nodes.map(({ id, type, seat, jammer, strategy, evGap }) => ({
      id,
      type,
      seat,
      jammer,
      strategy: strategy.map(round(4)),
      evGap: evGap.map(round(4)),
    })),
  };
}

/** Rebuilds range Maps (and heads-up aliases) for a serialized solution. */
export function deserializeSolution(data) {
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const n = data.seats.length;
  const seats = data.seats.map((s) => {
    const callVs = {};
    const rangeOf = (id) => strategyToRange(byId.get(id).strategy, byId.get(id).evGap, data.displayEpsilon ?? 0);
    for (let i = 0; i < s.seat; i++) callVs[i] = rangeOf(`call:${i}:${s.seat}`);
    return { ...s, openJam: s.seat < n - 1 ? rangeOf(`open:${s.seat}`) : null, callVs };
  });
  const solution = { ...data, seats };
  if (n === 2) {
    solution.sbJam = seats[0].openJam;
    solution.bbCall = seats[1].callVs[0];
  }
  return solution;
}

function readCache(key) {
  const data = load(key, null);
  if (!data || !Array.isArray(data.nodes)) return null;
  try {
    return deserializeSolution(data);
  } catch {
    return null;
  }
}

function writeCache(key, solution) {
  const index = load(INDEX_KEY, []).filter((k) => k !== key);
  index.unshift(key);
  while (index.length > CACHE_LIMIT) {
    const old = index.pop();
    try {
      localStorage.removeItem(old);
    } catch {
      // storage unavailable
    }
  }
  save(key, serializeSolution(solution));
  save(INDEX_KEY, index);
}

async function solveInline(method, params, onProgress) {
  const pushfold = await import('../nash/pushfold.js');
  const { ensureEquityTable } = await import('../nash/card-removal.js');
  await ensureEquityTable();
  const fn = { headsUp: pushfold.headsUpPushFold, table: pushfold.tablePushFold, multiway: pushfold.multiwayPushFold }[method];
  if (!fn) throw new Error(`Unknown solver "${method}"`);
  return fn({ ...params, onProgress });
}

/**
 * Solves a push/fold spot in the worker. params = { method: 'headsUp' | 'table' |
 * 'multiway' (default 'table'), ...solver parameters }. Resolves to the solution;
 * cached solutions resolve at once with `cached: true`.
 * onProgress({ iteration, exploitability }) is called while solving.
 */
export async function solveNash({ method = 'table', ...params } = {}, { onProgress, useCache = true } = {}) {
  const key = nashCacheKey(method, params);
  if (useCache) {
    const hit = readCache(key);
    if (hit) return { ...hit, cached: true };
  }
  let solution;
  if (typeof Worker === 'undefined') solution = await solveInline(method, params, onProgress);
  else {
    solution = await new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, onProgress });
      getWorker().postMessage({ id, method, params });
    });
  }
  if (useCache) writeCache(key, solution);
  return { ...solution, cached: false };
}

/** The cached solution for these parameters, or null. Never starts a solve. */
export function cachedSolution({ method = 'table', ...params } = {}) {
  const hit = readCache(nashCacheKey(method, params));
  return hit ? { ...hit, cached: true } : null;
}

/** Stops a running solve; its promise rejects with an error named 'AbortError'. */
export function cancelNash() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  const err = new Error('Solve cancelled');
  err.name = 'AbortError';
  failAll(err);
}
