// Runs Nash push/fold solves off the main thread.
import { headsUpPushFold, multiwayPushFold } from '../nash/pushfold.js';

self.onmessage = ({ data }) => {
  const { id, method, args } = data;
  const fn = method === 'headsUp' ? headsUpPushFold : multiwayPushFold;
  self.postMessage({ id, result: fn(args) });
};
