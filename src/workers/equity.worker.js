// Runs equity calculations off the main thread.
import { exactEquity, monteCarloEquity } from '../engine/equity.js';

self.onmessage = ({ data }) => {
  const { id, method, args } = data;
  const fn = method === 'exact' ? exactEquity : monteCarloEquity;
  self.postMessage({ id, result: fn(...args) });
};
