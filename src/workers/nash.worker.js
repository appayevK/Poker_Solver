// Runs Nash push/fold solves off the main thread.
// Request:  { id, method: 'headsUp' | 'table' | 'multiway', params }
// Messages: { id, progress: { iteration, exploitability } } while solving,
//           then { id, result } or { id, error }.
import { headsUpPushFold, tablePushFold, multiwayPushFold } from '../nash/pushfold.js';
import { ensureEquityTable } from '../nash/card-removal.js';

const solvers = { headsUp: headsUpPushFold, table: tablePushFold, multiway: multiwayPushFold };

self.onmessage = async ({ data }) => {
  const { id, method = 'table', params = {} } = data;
  try {
    const fn = solvers[method];
    if (!fn) throw new Error(`Unknown solver "${method}"`);
    await ensureEquityTable();
    const onProgress = (progress) => self.postMessage({ id, progress });
    const result = fn({ ...params, onProgress });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};
