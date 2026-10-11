// Writes data/flops/index.json: spots, solved flops with weights, texture labels and
// range-level summaries, so the Flop tab can show reports without loading every file.
// Usage: node scripts/flops/build-index.js
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, subsetFlops } from './common.js';
import { allSpots } from '../../src/flops/spots.js';
import { TEXTURE_GROUPS } from '../../src/flops/texture.js';
import { TREE } from '../../src/flops/tree-config.js';

const reps = new Map(subsetFlops().map((r) => [r.key, r]));
const spots = [];
let totalBytes = 0;
for (const spot of allSpots()) {
  const dir = join(DATA, spot.id);
  const flops = [];
  let bytes = 0;
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const rep = reps.get(data.flop);
      if (!rep) continue; // a flop no longer in the subset
      bytes += statSync(join(dir, file)).size;
      flops.push({
        key: data.flop,
        group: rep.group,
        label: rep.label,
        weight: rep.weight,
        raw: rep.raw,
        nodes: data.nodes.map((n) => ({ id: n.id, player: n.player, label: n.label, actions: n.actions.map(({ key, label }) => ({ key, label })), summary: n.summary, line: n.line })),
        ...(data.solve ? { solve: data.solve } : {}),
      });
    }
  }
  totalBytes += bytes;
  spots.push({
    id: spot.id,
    label: spot.label,
    type: spot.type,
    ip: spot.ip,
    oop: spot.oop,
    preflop: spot.preflop,
    pot: spot.pot,
    stack: spot.stack,
    bytes,
    flops,
  });
  console.log(`${spot.id}: ${flops.length} solved flops, ${(bytes / 1024).toFixed(0)} KB`);
}
const index = { version: 1, groups: TEXTURE_GROUPS, tree: TREE, spots };
writeFileSync(join(DATA, 'index.json'), `${JSON.stringify(index)}\n`);
console.log(`Wrote data/flops/index.json (${(statSync(join(DATA, 'index.json')).size / 1024).toFixed(0)} KB); flop data ${(totalBytes / 1024).toFixed(0)} KB in total.`);
