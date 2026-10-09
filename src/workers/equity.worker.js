// Runs equity calculations off the main thread.
// Request:  { id, method: 'auto' | 'exact' | 'montecarlo', players, board, dead, iterations, seed }
// Response: { id, result } or { id, error }
import { exactEquity, monteCarloEquity, chooseMethod } from '../engine/equity.js';

self.onmessage = ({ data }) => {
  const { id, method = 'auto', players, board = [], dead = [], iterations, seed } = data;
  try {
    const t0 = performance.now();
    const use = method === 'auto' ? chooseMethod(players, board, dead) : method;
    const result =
      use === 'exact'
        ? exactEquity(players, board, dead)
        : monteCarloEquity(players, board, { iterations, seed, dead });
    result.elapsedMs = performance.now() - t0;
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};
