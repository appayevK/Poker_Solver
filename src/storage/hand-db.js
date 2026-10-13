// Hand library in IndexedDB: thousands of hands with notes, tags and edited ranges do
// not fit in localStorage.
//
//   const db = await openHandDB();
//   await db.save(hands)                  → { added, duplicates } (dedupe by hand id)
//   await db.list({ format, position, flagged, tag, search, sort: 'date' | 'result', order })
//   await db.update(id, { notes, tags, ranges, flags })
//   await db.get(id) / db.delete(id) / db.clear() / db.count()
//
// Each record is the hand plus a small summary used by the list (hero position and
// cards, result in bb, flag count), so listing never has to replay hands.

import { heroResultBB, heroPlayer } from '../review/hand.js';
import { cardsToString } from '../engine/cards.js';

const DB_NAME = 'poker-solver';
const VERSION = 1;
const STORE = 'hands';
/** Fields update() may change; everything else comes from the hand history. */
export const EDITABLE = ['notes', 'tags', 'ranges', 'flags', 'analysedAt'];

const req = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });

/** List summary for a hand: { position, cards, resultBB, flags, stakes }. */
export function summarize(hand) {
  const hero = heroPlayer(hand);
  const { sb, bb } = hand.blinds;
  const money = (x) => (hand.unit.currency ? `${hand.unit.currency}${x / hand.unit.scale}` : String(x));
  return {
    position: hero?.position ?? null,
    cards: hero?.cards ? cardsToString(hero.cards) : null,
    resultBB: Math.round(heroResultBB(hand) * 100) / 100,
    flags: hand.flags?.length ?? 0,
    stakes: `${money(sb)}/${money(bb)}`,
  };
}

function toRecord(hand, existing) {
  return { ...hand, ranges: existing?.ranges ?? hand.ranges ?? {}, summary: summarize(hand), savedAt: existing?.savedAt ?? new Date().toISOString() };
}

function matches(rec, f) {
  if (f.format && rec.format !== f.format) return false;
  if (f.position && rec.summary.position !== f.position) return false;
  if (f.flagged && !(rec.flags?.length > 0)) return false;
  if (f.tag && !rec.tags.includes(f.tag)) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const text = [rec.id, rec.table, rec.notes, rec.summary.cards, ...rec.tags, ...rec.players.map((p) => p.name)].join(' ').toLowerCase();
    if (!text.includes(q)) return false;
  }
  return true;
}

/**
 * Same API kept in memory, for browsers where IndexedDB is blocked (some private
 * windows). Hands last until the page is closed.
 */
export function createMemoryHandDB() {
  const records = new Map();
  return {
    memory: true,
    async save(hands) {
      let added = 0;
      let duplicates = 0;
      for (const hand of hands) {
        if (records.has(hand.id)) duplicates++;
        else {
          records.set(hand.id, structuredClone(toRecord(hand)));
          added++;
        }
      }
      return { added, duplicates };
    },
    async get(id) {
      return records.has(id) ? structuredClone(records.get(id)) : null;
    },
    async list(filters = {}) {
      return sortRecords([...records.values()].filter((r) => matches(r, filters)), filters).map((r) => structuredClone(r));
    },
    async update(id, patch) {
      for (const key of Object.keys(patch)) if (!EDITABLE.includes(key)) throw new Error(`Cannot change "${key}" of a stored hand`);
      const rec = records.get(id);
      if (!rec) throw new Error(`No hand ${id} in the library`);
      const next = { ...rec, ...structuredClone(patch) };
      next.summary = summarize(next);
      records.set(id, next);
      return structuredClone(next);
    },
    async delete(id) {
      records.delete(id);
    },
    async clear() {
      records.clear();
    },
    async count() {
      return records.size;
    },
    async tags() {
      return [...new Set([...records.values()].flatMap((r) => r.tags))].sort();
    },
    close() {},
  };
}

function sortRecords(out, filters) {
  const dir = filters.order === 'asc' ? 1 : -1;
  if (filters.sort === 'result') out.sort((a, b) => dir * (a.summary.resultBB - b.summary.resultBB));
  else out.sort((a, b) => dir * String(a.date).localeCompare(String(b.date)) || dir * a.id.localeCompare(b.id));
  return filters.limit ? out.slice(0, filters.limit) : out;
}

/** Opens (or creates) the library. options: { name, indexedDB } for tests. */
export async function openHandDB({ name = DB_NAME, indexedDB = globalThis.indexedDB } = {}) {
  if (!indexedDB) throw new Error('IndexedDB is not available in this browser');
  const open = indexedDB.open(name, VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(STORE)) {
      const store = db.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('date', 'date');
    }
  };
  const db = await req(open);
  const store = (mode) => db.transaction(STORE, mode).objectStore(STORE);

  return {
    /** Adds hands; ones already in the library (same id) are skipped so notes survive. */
    async save(hands) {
      const known = new Set(await req(store('readonly').getAllKeys()));
      const tx = db.transaction(STORE, 'readwrite');
      const s = tx.objectStore(STORE);
      let added = 0;
      let duplicates = 0;
      for (const hand of hands) {
        if (known.has(hand.id)) {
          duplicates++;
          continue;
        }
        known.add(hand.id);
        s.put(toRecord(hand));
        added++;
      }
      await done(tx);
      return { added, duplicates };
    },
    async get(id) {
      return (await req(store('readonly').get(id))) ?? null;
    },
    /**
     * Hands matching the filters, newest first by default.
     * filters: { format, position, flagged, tag, search, sort: 'date' | 'result', order: 'asc' | 'desc', limit }
     */
    async list(filters = {}) {
      const all = await req(store('readonly').getAll());
      return sortRecords(all.filter((r) => matches(r, filters)), filters);
    },
    /** Changes notes, tags, ranges or flags of a stored hand; returns the updated record. */
    async update(id, patch) {
      for (const key of Object.keys(patch)) if (!EDITABLE.includes(key)) throw new Error(`Cannot change "${key}" of a stored hand`);
      const rec = await req(store('readonly').get(id));
      if (!rec) throw new Error(`No hand ${id} in the library`);
      const next = { ...rec, ...patch };
      next.summary = summarize(next);
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(next);
      await done(tx);
      return next;
    },
    async delete(id) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      await done(tx);
    },
    async clear() {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      await done(tx);
    },
    async count() {
      return req(store('readonly').count());
    },
    /** All distinct tags in the library, sorted. */
    async tags() {
      const all = await req(store('readonly').getAll());
      return [...new Set(all.flatMap((r) => r.tags))].sort();
    },
    close() {
      db.close();
    },
  };
}
