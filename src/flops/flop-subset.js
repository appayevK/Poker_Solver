// Representative flop subset.
//
// The 1755 canonical flops are split into texture groups (texture.js). Each group
// gets representatives in proportion to how often its boards come up (at least
// `minPerGroup`), chosen by farthest-point sampling and refined with a few k-medoids
// passes. Every canonical flop is then assigned to the nearest representative in its
// group. A representative's `weight` is how many canonical flops it stands for
// (weights sum to 1755); `raw` is how many of the 22,100 real flops it stands for,
// which is what reports use, since real boards come up in proportion to raw counts.

import { allCanonicalFlops } from './canonical.js';
import { flopFeatures, textureGroup, textureLabel, textureDistance, TEXTURE_GROUPS } from './texture.js';

function withFeatures() {
  return allCanonicalFlops().map((f) => {
    const features = flopFeatures(f.cards);
    return { ...f, features, group: textureGroup(features), label: textureLabel(features) };
  });
}

/**
 * Splits `total` across groups: `min` each (1 for groups of fewer than 30 flops,
 * such as trips), the rest by raw share (largest remainder).
 */
function allocate(groups, total, min) {
  const sizes = groups.map((g) => g.flops.length);
  const raw = groups.map((g) => g.flops.reduce((s, f) => s + f.raw, 0));
  const counts = sizes.map((n) => (n < 30 ? 1 : Math.min(n, min)));
  let left = total - counts.reduce((a, b) => a + b, 0);
  const rawTotal = raw.reduce((a, b) => a + b, 0);
  const ideal = raw.map((r) => (r / rawTotal) * left);
  const extra = ideal.map(Math.floor);
  extra.forEach((e, i) => {
    counts[i] = Math.min(sizes[i], counts[i] + e);
  });
  left = total - counts.reduce((a, b) => a + b, 0);
  const order = ideal.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && k < order.length * 4; k++) {
    const i = order[k % order.length][1];
    if (counts[i] < sizes[i]) {
      counts[i]++;
      left--;
    }
  }
  return counts;
}

/** Picks k medoids from a group (deterministic). */
function pickRepresentatives(flops, k) {
  const n = flops.length;
  const d = flops.map((a) => flops.map((b) => textureDistance(a.features, b.features)));
  const cost = (i) => flops.reduce((s, f, j) => s + f.raw * d[i][j], 0);
  let reps = [flops.map((_, i) => i).reduce((best, i) => (cost(i) < cost(best) ? i : best), 0)];
  while (reps.length < k) {
    let far = -1;
    let farDist = -1;
    for (let i = 0; i < n; i++) {
      if (reps.includes(i)) continue;
      const dist = Math.min(...reps.map((r) => d[i][r]));
      if (dist > farDist) {
        farDist = dist;
        far = i;
      }
    }
    reps.push(far);
  }
  for (let pass = 0; pass < 8; pass++) {
    const clusters = reps.map(() => []);
    for (let i = 0; i < n; i++) {
      let best = 0;
      for (let r = 1; r < reps.length; r++) if (d[i][reps[r]] < d[i][reps[best]]) best = r;
      clusters[best].push(i);
    }
    const next = clusters.map((members, r) =>
      members.length ? members.reduce((best, i) => (members.reduce((s, j) => s + flops[j].raw * d[i][j], 0) < members.reduce((s, j) => s + flops[j].raw * d[best][j], 0) ? i : best), members[0]) : reps[r],
    );
    if (next.every((x, i) => x === reps[i])) break;
    reps = next;
  }
  return reps.map((i) => flops[i]);
}

/**
 * Builds the subset: { total, representatives: [{ key, group, label, weight, raw, members }] }.
 * members lists the canonical keys each representative stands for (itself included).
 */
export function buildSubset({ target = 80, minPerGroup = 3 } = {}) {
  const flops = withFeatures();
  const groups = TEXTURE_GROUPS.map((name) => ({ name, flops: flops.filter((f) => f.group === name) }));
  const counts = allocate(groups, target, minPerGroup);
  const representatives = [];
  groups.forEach((g, gi) => {
    const reps = pickRepresentatives(g.flops, counts[gi]);
    const members = reps.map(() => []);
    for (const f of g.flops) {
      let best = 0;
      for (let r = 1; r < reps.length; r++) {
        if (textureDistance(f.features, reps[r].features) < textureDistance(f.features, reps[best].features)) best = r;
      }
      members[best].push(f);
    }
    reps.forEach((rep, r) => {
      representatives.push({
        key: rep.key,
        group: g.name,
        label: rep.label,
        weight: members[r].length,
        raw: members[r].reduce((s, f) => s + f.raw, 0),
        members: members[r].map((f) => f.key),
      });
    });
  });
  return { total: flops.length, representatives };
}
