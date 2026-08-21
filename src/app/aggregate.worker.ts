import { accumulate, createAccumulator, snapshot, type AggEvent } from './aggregate';

/**
 * Aggregation runs here so the main thread only paints. Batches arrive once per
 * animation frame; the snapshot goes back on a slow, fixed cadence — posting one
 * message per batch would just move the flooding problem across the wire.
 */
const SNAPSHOT_MS = 250;

// The build typechecks this file against the DOM lib, where `self` is a Window
// and `postMessage` demands a target origin. Casting once here is cheaper than a
// second tsconfig for one file.
const post = self.postMessage as unknown as (message: unknown) => void;

const acc = createAccumulator();
let lastPosted = -1;

addEventListener('message', (event) => {
  accumulate(acc, (event as MessageEvent).data as AggEvent[]);
});

setInterval(() => {
  // Nothing arrived since the last snapshot: skip the message, skip the render.
  if (acc.total === lastPosted) return;
  lastPosted = acc.total;
  post(snapshot(acc, Date.now()));
}, SNAPSHOT_MS);
