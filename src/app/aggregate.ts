/**
 * Pure aggregation over the event stream. No DOM, no Angular, no timers — this
 * file is what runs inside the Web Worker, and it is what the unit tests call
 * directly. Keeping it free of globals is the only reason both are possible.
 */

/** The subset of a change the aggregator needs. Cheap to structured-clone. */
export interface AggEvent {
  /** Host the change happened on, e.g. `en.wikipedia.org`. */
  readonly wiki: string;
  readonly bot: boolean;
  readonly type: string;
  readonly title: string;
  /** Byte delta of the edit; 0 for events that do not change page length. */
  readonly delta: number;
  /** Epoch milliseconds, taken on arrival. */
  readonly t: number;
}

export interface TopEntry {
  readonly key: string;
  readonly count: number;
}

export interface Stats {
  readonly total: number;
  readonly bots: number;
  readonly humans: number;
  readonly byType: readonly TopEntry[];
  readonly topWikis: readonly TopEntry[];
  readonly topPages: readonly TopEntry[];
  /** Counts per bucket, index-aligned with {@link SIZE_BUCKETS}. */
  readonly sizeBuckets: readonly number[];
  /** One count per second for the last {@link RATE_WINDOW_SEC} seconds, oldest first. */
  readonly perSecond: readonly number[];
  /** Mean events/second over the last completed {@link RATE_MEAN_SEC} seconds. */
  readonly ratePerSec: number;
}

/** Histogram edges for the byte delta of an edit. */
export const SIZE_BUCKETS = [
  '≤ −1 kB',
  '−1 kB … −100 B',
  '−99 … −1 B',
  'no change',
  '+1 … +99 B',
  '+100 … +999 B',
  '≥ +1 kB',
] as const;

export const RATE_WINDOW_SEC = 60;
export const RATE_MEAN_SEC = 5;

/**
 * Page titles are unbounded — every distinct page seen is a new key. Prune back
 * to the heaviest hitters once the table gets big.
 * Keeping the top N after a sort is a biased approximation (a page
 * that trickles in below the cut is forgotten and starts from zero). Fine for a
 * "what is hot right now" panel; swap in space-saving/count-min if it ever has
 * to be defensible under adversarial cardinality.
 */
const PAGE_KEYS_MAX = 5_000;
const PAGE_KEYS_KEEP = 500;

export interface Accumulator {
  total: number;
  bots: number;
  readonly byWiki: Map<string, number>;
  readonly byPage: Map<string, number>;
  readonly byType: Map<string, number>;
  readonly sizeBuckets: number[];
  /** epoch second -> events seen in it. */
  readonly perSecond: Map<number, number>;
}

export function createAccumulator(): Accumulator {
  return {
    total: 0,
    bots: 0,
    byWiki: new Map(),
    byPage: new Map(),
    byType: new Map(),
    sizeBuckets: SIZE_BUCKETS.map(() => 0),
    perSecond: new Map(),
  };
}

export function sizeBucket(delta: number): number {
  if (delta <= -1000) return 0;
  if (delta <= -100) return 1;
  if (delta < 0) return 2;
  if (delta === 0) return 3;
  if (delta < 100) return 4;
  if (delta < 1000) return 5;
  return 6;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function accumulate(acc: Accumulator, events: readonly AggEvent[]): void {
  for (const e of events) {
    acc.total++;
    if (e.bot) acc.bots++;
    bump(acc.byWiki, e.wiki);
    bump(acc.byPage, e.title);
    bump(acc.byType, e.type);
    acc.sizeBuckets[sizeBucket(e.delta)]++;
    const second = Math.floor(e.t / 1000);
    acc.perSecond.set(second, (acc.perSecond.get(second) ?? 0) + 1);
  }
  if (acc.byPage.size > PAGE_KEYS_MAX) prune(acc.byPage, PAGE_KEYS_KEEP);
}

/** Keep only the `keep` heaviest keys. Mutates in place. */
function prune(map: Map<string, number>, keep: number): void {
  for (const { key } of top(map, Number.MAX_SAFE_INTEGER).slice(keep)) map.delete(key);
}

/** Highest counts first; ties broken by key so the output is stable. */
function top(map: Map<string, number>, n: number): TopEntry[] {
  return [...map]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, n);
}

/**
 * Read the accumulator. Also drops rate buckets that fell out of the window —
 * the only thing in here that grows without a bound otherwise.
 */
export function snapshot(acc: Accumulator, now: number, topN = 8): Stats {
  const currentSecond = Math.floor(now / 1000);
  const oldest = currentSecond - RATE_WINDOW_SEC + 1;
  for (const second of acc.perSecond.keys()) {
    if (second < oldest) acc.perSecond.delete(second);
  }

  const perSecond: number[] = [];
  for (let s = oldest; s <= currentSecond; s++) perSecond.push(acc.perSecond.get(s) ?? 0);

  // The current second is still filling up, so averaging it in reads low.
  const completed = perSecond.slice(-RATE_MEAN_SEC - 1, -1);
  const ratePerSec = completed.length ? completed.reduce((a, b) => a + b, 0) / completed.length : 0;

  return {
    total: acc.total,
    bots: acc.bots,
    humans: acc.total - acc.bots,
    byType: top(acc.byType, topN),
    topWikis: top(acc.byWiki, topN),
    topPages: top(acc.byPage, topN),
    sizeBuckets: [...acc.sizeBuckets],
    perSecond,
    ratePerSec,
  };
}
