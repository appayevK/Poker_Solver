// Promise-based access to the equity worker.
//
//   const result = await runEquity({ method: 'auto', players: ['AsKd', 'QQ+, AKs'], board: 'Qh7s2s' });
//
// players entries are hand strings, range strings or range Maps (all structured-cloneable).
// Falls back to running on the calling thread where Web Workers are unavailable (e.g. Node).

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./equity.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.result);
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    failAll(new Error(event.message || 'Equity worker failed'));
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function failAll(err) {
  for (const job of pending.values()) job.reject(err);
  pending.clear();
}

async function runInline({ method, players, board, dead, iterations, seed }) {
  const { exactEquity, monteCarloEquity, chooseMethod } = await import('../engine/equity.js');
  const t0 = performance.now();
  const use = method === 'auto' ? chooseMethod(players, board, dead) : method;
  const result =
    use === 'exact' ? exactEquity(players, board, dead) : monteCarloEquity(players, board, { iterations, seed, dead });
  result.elapsedMs = performance.now() - t0;
  return result;
}

/**
 * Runs an equity calculation in the worker.
 * method: 'auto' (exact when cheap, else Monte Carlo) | 'exact' | 'montecarlo'.
 * Resolves to the engine result plus elapsedMs.
 */
export function runEquity({ method = 'auto', players, board = [], dead = [], iterations = 200000, seed } = {}) {
  const request = { method, players, board, dead, iterations, seed };
  if (typeof Worker === 'undefined') return runInline(request);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...request });
  });
}

/** Stops any running calculation; pending promises reject with an error named 'AbortError'. */
export function cancelEquity() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  const err = new Error('Calculation cancelled');
  err.name = 'AbortError';
  failAll(err);
}
