// Builds data/flops/subset.json: representative flops, their texture labels and the
// canonical flops each one stands for. Run with: npm run flops:subset
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSubset } from '../../src/flops/flop-subset.js';

const OUT = new URL('../../data/flops/subset.json', import.meta.url);
const t0 = performance.now();
const subset = buildSubset({ target: Number(process.argv[2] ?? 80) });
const weight = subset.representatives.reduce((s, r) => s + r.weight, 0);
const raw = subset.representatives.reduce((s, r) => s + r.raw, 0);
writeFileSync(OUT, `${JSON.stringify({ total: subset.total, representatives: subset.representatives }, null, 1)}\n`);
const groups = new Map();
for (const r of subset.representatives) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
for (const [g, reps] of groups) {
  console.log(`${g.padEnd(14)} ${String(reps.length).padStart(2)} reps, ${String(reps.reduce((s, r) => s + r.weight, 0)).padStart(4)} flops: ${reps.map((r) => r.key).join(' ')}`);
}
console.log(`${subset.representatives.length} representatives, weights sum to ${weight} of ${subset.total} (raw ${raw}); wrote ${fileURLToPath(OUT)} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
