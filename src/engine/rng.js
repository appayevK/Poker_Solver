// Seedable PRNG (xoshiro128**, seeded through splitmix32) so Monte Carlo runs are reproducible.

/** Returns a function producing uint32 values, with .float() in [0, 1) and .int(n) in [0, n). */
export function createRng(seed = 0) {
  let x = seed >>> 0;
  const splitmix = () => {
    x = (x + 0x9e3779b9) | 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = splitmix();
  let b = splitmix();
  let c = splitmix();
  let d = splitmix();

  const next = () => {
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9);
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return r >>> 0;
  };
  next.float = () => next() / 4294967296;
  next.int = (n) => Math.floor((next() / 4294967296) * n);
  return next;
}

function rotl(v, k) {
  return (v << k) | (v >>> (32 - k));
}

/** A fresh non-deterministic seed. */
export function randomSeed() {
  return (Math.random() * 4294967296) >>> 0;
}
