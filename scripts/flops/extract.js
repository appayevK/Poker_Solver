// Reads finished TexasSolver outputs and writes compact study data to
// data/flops/<spot>/<flop>.json. Usage: node scripts/flops/extract.js [--spot srp-btn-bb]
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { paths, ensureDir, parseArgs, subsetFlops, DATA } from './common.js';
import { allSpots } from '../../src/flops/spots.js';
import { extractFlop } from '../../src/flops/extract.js';
import { TREE } from '../../src/flops/tree-config.js';

const args = parseArgs();
const spots = allSpots().filter((s) => !args.spot || s.id === args.spot);
let count = 0;
for (const spot of spots) {
  let bytes = 0;
  // The tree these solves used (written by make-configs), so sizes are read correctly.
  const treeFile = join(dirname(paths.input(spot.id, 'x')), 'tree.json');
  const tree = existsSync(treeFile) ? JSON.parse(readFileSync(treeFile, 'utf8')) : TREE;
  for (const { key } of subsetFlops()) {
    const output = paths.output(spot.id, key);
    const log = paths.log(spot.id, key);
    if (!existsSync(output) || !existsSync(log)) continue;
    const record = JSON.parse(readFileSync(log, 'utf8'));
    const dump = JSON.parse(readFileSync(output, 'utf8'));
    const data = extractFlop({
      dump,
      spot,
      flop: key,
      solve: { iterations: record.iterations, exploitability: record.exploitability, seconds: Math.round(record.seconds), tree: tree.name ?? 'custom' },
      tree,
    });
    const file = paths.data(spot.id, key);
    ensureDir(file);
    writeFileSync(file, JSON.stringify(data));
    bytes += statSync(file).size;
    count++;
  }
  const dir = join(DATA, spot.id);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
  if (files) console.log(`${spot.id}: ${files} flops, ${(bytes / 1024).toFixed(0)} KB written this run`);
}
console.log(`Extracted ${count} flops to data/flops/.`);
