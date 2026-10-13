import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { parseGGFile } from '../src/review/gg-parser.js';
import { openHandDB, createMemoryHandDB, summarize } from '../src/storage/hand-db.js';

const hands = parseGGFile(readFileSync('tests/fixtures/hand-histories/cash-nl25-01.txt', 'utf8')).hands.map((x) => x.hand);

for (const [name, open] of [
  ['IndexedDB', () => openHandDB({ indexedDB: new IDBFactory() })],
  ['memory', async () => createMemoryHandDB()],
]) {
  describe(`hand library (${name})`, () => {
    let db;
    beforeEach(async () => {
      db = await open();
    });

    it('saves hands and skips the ones already there', async () => {
      expect(await db.save(hands)).toEqual({ added: 19, duplicates: 0 });
      expect(await db.save(hands.slice(0, 5))).toEqual({ added: 0, duplicates: 5 });
      expect(await db.count()).toBe(19);
    });

    it('lists with filters and sorts', async () => {
      await db.save(hands);
      expect((await db.list({ position: 'CO' })).map((r) => r.summary.position)).toEqual(['CO', 'CO', 'CO', 'CO']);
      const newest = await db.list();
      expect(newest[0].id).toBe('HD3083051249');
      expect((await db.list({ order: 'asc' }))[0].id).toBe('HD3083049526');
      const losses = await db.list({ sort: 'result', order: 'asc' });
      expect(losses[0]).toMatchObject({ id: 'HD3083049734', summary: { resultBB: -35.28, cards: 'KhAc', position: 'CO', stakes: '$0.1/$0.25' } });
      expect((await db.list({ search: 'KhKs' })).map((r) => r.id)).toEqual(['HD3083049905']);
      expect(await db.list({ format: 'mtt' })).toEqual([]);
      expect(await db.list({ flagged: true })).toEqual([]);
      expect(await db.list({ limit: 3 })).toHaveLength(3);
    });

    it('updates notes, tags, ranges and flags, and keeps them on re-import', async () => {
      await db.save(hands);
      const flags = [{ type: 'callBelowRequired', street: 'flop', actionIndex: 12, severity: 'medium', message: 'x' }];
      const rec = await db.update('HD3083049734', { notes: 'cooler', tags: ['cooler', 'AK'], ranges: { 12: { villain: 'c4e5faf1', range: 'TT+,AK' } }, flags });
      expect(rec.summary.flags).toBe(1);
      await db.save(hands);
      const back = await db.get('HD3083049734');
      expect(back).toMatchObject({ notes: 'cooler', tags: ['cooler', 'AK'], ranges: { 12: { villain: 'c4e5faf1', range: 'TT+,AK' } } });
      expect(await db.tags()).toEqual(['AK', 'cooler']);
      expect((await db.list({ tag: 'AK' })).map((r) => r.id)).toEqual(['HD3083049734']);
      expect((await db.list({ flagged: true })).map((r) => r.id)).toEqual(['HD3083049734']);
      expect((await db.list({ search: 'cooler' })).map((r) => r.id)).toEqual(['HD3083049734']);
      await expect(db.update('HD3083049734', { pot: 0 })).rejects.toThrow(/Cannot change "pot"/);
      await expect(db.update('nope', { notes: '' })).rejects.toThrow(/No hand/);
    });

    it('deletes and clears', async () => {
      await db.save(hands);
      await db.delete('HD3083049734');
      expect(await db.get('HD3083049734')).toBeNull();
      expect(await db.count()).toBe(18);
      await db.clear();
      expect(await db.count()).toBe(0);
    });
  });
}

describe('summarize', () => {
  it('describes a hand for the list', () => {
    expect(summarize(hands.find((h) => h.id === 'HD3083050772'))).toEqual({ position: 'SB', cards: 'Ac8h', resultBB: 4.56, flags: 0, stakes: '$0.1/$0.25' });
  });
});
