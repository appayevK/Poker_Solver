// Writes one TexasSolver input file per (spot, flop) to solver-work/inputs/.
// Usage: node scripts/flops/make-configs.js [--spot srp-btn-bb] [--limit 5] [--threads 16]
//        [--tree laptop|full]   (laptop: about 3 GB per solve; full: the bigger spec tree, ~16 GB)
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { allSpots } from '../../src/flops/spots.js';
import { buildSolverInput } from '../../src/flops/solver-input.js';
import { treePreset } from '../../src/flops/tree-config.js';
import { paths, ensureDir, parseArgs, subsetFlops } from './common.js';

const args = parseArgs();
const threads = Number(args.threads ?? Math.max(1, cpus().length - 2));
const tree = treePreset(args.tree ?? 'laptop');
const flops = subsetFlops().slice(0, args.limit ? Number(args.limit) : undefined);
const spots = allSpots().filter((s) => !args.spot || s.id === args.spot);
if (!spots.length) throw new Error(`Unknown spot "${args.spot}"`);

const share = (range) => {
  let combos = 0;
  range.forEach((w, c) => {
    combos += w * (c % 14 === 0 ? 6 : Math.floor(c / 13) < c % 13 ? 4 : 12);
  });
  return `${((combos / 1326) * 100).toFixed(1)}%`;
};

let written = 0;
for (const spot of spots) {
  console.log(
    `${spot.id}: ${spot.preflop}. Pot ${spot.pot}bb, effective stack ${spot.stack}bb (each put in ${spot.invested}bb, dead ${spot.dead}bb). ` +
      `IP ${spot.ip} ${share(spot.ranges.ip)} of hands, OOP ${spot.oop} ${share(spot.ranges.oop)}.`,
  );
  for (const { key } of flops) {
    const file = paths.input(spot.id, key);
    ensureDir(file);
    ensureDir(paths.output(spot.id, key));
    writeFileSync(file, buildSolverInput({ spot, flop: key, dumpPath: paths.output(spot.id, key), threads, tree }));
    written++;
  }
  // Which tree these inputs use, so extraction and the app can record it.
  writeFileSync(join(dirname(paths.input(spot.id, 'x')), 'tree.json'), `${JSON.stringify(tree, null, 1)}\n`);
}
console.log(`Wrote ${written} input files (tree "${tree.name}", ${threads} threads each) to solver-work/inputs/.`);
