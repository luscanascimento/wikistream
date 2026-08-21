import { DestroyRef, Injectable, afterEveryRender, computed, inject, signal } from '@angular/core';
import type { AggEvent, Stats } from './aggregate';
import { RingBuffer } from './ring-buffer';
import { WikiStream, type RecentChange } from './wiki-stream';

/** Rows kept in memory. Everything past this is evicted — bounded, on purpose. */
export const RETAIN = 500;
/**
 * Retention ceiling when backpressure is off. The naive implementation being
 * compared against has no ring buffer at all and grows without limit; this is a
 * safety net, high enough that the growth is what you see and low enough that
 * the tab stays recoverable.
 */
const NAIVE_RETAIN = 20_000;
/** Ceiling on the between-frames buffer. Past this the oldest events are dropped. */
export const PENDING_MAX = 1_000;
/** How often the instrument panel is recomputed. Faster than this is unreadable. */
const METRICS_MS = 200;
/** How much history every rate, average and peak on the panel covers. */
const RATE_WINDOW_MS = 1_000;

export type AgentFilter = 'all' | 'bot' | 'human';

/** A row of the feed. Superset of {@link AggEvent} so one object serves both. */
export interface FeedItem extends AggEvent {
  readonly seq: number;
  readonly user: string;
}

/**
 * Wire payload to feed row. `length` is absent on events that do not change a
 * page (log actions, categorisations) and either side can be null, so a missing
 * end counts as zero rather than propagating NaN into the histogram.
 */
export function toFeedItem(change: RecentChange, seq: number, t: number): FeedItem {
  const length = change.length;
  return {
    seq,
    title: change.title,
    user: change.user,
    wiki: change.server_name,
    type: change.type,
    bot: change.bot,
    delta: (length?.new ?? 0) - (length?.old ?? 0),
    t,
  };
}

export interface Metrics {
  /** Events entering the pipeline per second, synthetic multiplier included. */
  readonly ingestedPerSec: number;
  /** Events that actually reached the feed per second. */
  readonly renderedPerSec: number;
  /** Change detection passes per second, measured by Angular's render hook. */
  readonly rendersPerSec: number;
  /** Main-thread milliseconds per second burnt inside the pipeline itself. */
  readonly cpuMsPerSec: number;
  /** Rows currently held in memory. */
  readonly retained: number;
  /** Events ingested but never shown, because the buffer was full or paused. */
  readonly dropped: number;
  /** Deepest the between-frames buffer got during the sample window. */
  readonly bufferPeak: number;
  readonly frameAvgMs: number;
  readonly frameWorstMs: number;
  /** Real events off the wire, before the synthetic multiplier. */
  readonly wireTotal: number;
}

const NO_METRICS: Metrics = {
  ingestedPerSec: 0,
  renderedPerSec: 0,
  rendersPerSec: 0,
  cpuMsPerSec: 0,
  retained: 0,
  dropped: 0,
  bufferPeak: 0,
  frameAvgMs: 0,
  frameWorstMs: 0,
  wireTotal: 0,
};

/**
 * The rendering pipeline: buffer, flush, measure.
 *
 * The stream delivers each event in its own task, so a signal write per event is
 * a change detection pass per event. Instead events land in a plain array and a
 * single animation frame flushes the whole batch with one write — the number of
 * renders is then bounded by the display refresh rate rather than by the
 * upstream event rate, however fast the firehose runs.
 */
@Injectable({ providedIn: 'root' })
export class Feed {
  private readonly stream = inject(WikiStream);

  private readonly _items = signal<readonly FeedItem[]>([]);
  private readonly _stats = signal<Stats | null>(null);
  private readonly _metrics = signal<Metrics>(NO_METRICS);

  readonly items = this._items.asReadonly();
  /** Aggregates computed off-thread. Null until the worker's first snapshot. */
  readonly stats = this._stats.asReadonly();
  readonly metrics = this._metrics.asReadonly();

  /** Freeze the feed. Events keep arriving, so the buffer fills and then drops. */
  readonly paused = signal(false);
  /** Off = one render per event, the naive implementation, for comparison. */
  readonly backpressure = signal(true);
  /** Copies made of each real event to simulate a faster stream. 1 = untouched. */
  readonly stress = signal(1);
  readonly wiki = signal('');
  readonly agents = signal<AgentFilter>('all');

  readonly filtered = computed(() => this.wiki() !== '' || this.agents() !== 'all');

  readonly visible = computed(() => {
    const wiki = this.wiki();
    const agents = this.agents();
    if (wiki === '' && agents === 'all') return this._items();
    return this._items().filter(
      (i) => (wiki === '' || i.wiki === wiki) && (agents === 'all' || i.bot === (agents === 'bot')),
    );
  });

  /** Everything ingested between two frames. Bounded, drops the oldest. */
  private readonly pending = new RingBuffer<FeedItem>(PENDING_MAX);
  private outbound: FeedItem[] = [];
  private seq = 0;

  private ingested = 0;
  private renderedTotal = 0;
  /** Drops the buffer cannot account for: events discarded while paused. */
  private droppedTotal = 0;
  private renders = 0;
  /** Main-thread milliseconds spent inside the pipeline since page load. */
  private cpuMs = 0;
  /** Counter readings kept for the width of the rate window. */
  private samples: {
    t: number;
    ingested: number;
    rendered: number;
    renders: number;
    cpuMs: number;
  }[] = [];

  private frames = 0;
  private frameSum = 0;
  private frameWorst = 0;
  private lastFrameAt = 0;
  private lastMetricsAt = 0;
  private windowAt = 0;
  private rafId = 0;

  private readonly worker =
    typeof Worker === 'undefined'
      ? null
      : new Worker(new URL('./aggregate.worker', import.meta.url), { type: 'module' });

  constructor() {
    // Counts real change detection passes rather than inferring them from our
    // own flushes — the difference between the two modes has to be measured,
    // not asserted.
    afterEveryRender(() => this.renders++);

    if (this.worker) {
      this.worker.onmessage = (event: MessageEvent<Stats>) => this._stats.set(event.data);
    }

    this.stream.sink = (change) => this.ingest(change);
    this.rafId = requestAnimationFrame(this.frame);

    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(this.rafId);
      this.stream.sink = () => {};
      this.worker?.terminate();
    });
  }

  private ingest(change: RecentChange): void {
    // Timed once per wire event, not once per copy: the measurement has to stay
    // negligible next to the work it measures.
    const started = performance.now();
    const copies = this.stress();
    const now = Date.now();
    for (let i = 0; i < copies; i++) {
      const item = toFeedItem(change, this.seq++, now);
      this.ingested++;
      this.outbound.push(item);
      // Buffered path: no signal write, so no render until the next frame.
      if (this.backpressure()) this.pending.push(item);
      else this.renderNow(item);
    }
    this.cpuMs += performance.now() - started;
  }

  /**
   * Naive path: a signal write per event over a list that is allowed to grow.
   * Copying the whole list per event is O(n) in the retained rows, so the cost
   * climbs as the list fills — which is the point of the comparison.
   */
  private renderNow(item: FeedItem): void {
    if (this.paused()) {
      this.droppedTotal++;
      return;
    }
    this.renderedTotal++;
    this._items.update((items) => [item, ...items].slice(0, NAIVE_RETAIN));
  }

  private readonly frame = (now: number): void => {
    this.rafId = requestAnimationFrame(this.frame);

    const delta = now - this.lastFrameAt;
    if (this.lastFrameAt > 0 && delta < 2_000) {
      this.frames++;
      this.frameSum += delta;
      if (delta > this.frameWorst) this.frameWorst = delta;
    }
    this.lastFrameAt = now;

    if (this.outbound.length > 0) {
      this.worker?.postMessage(this.outbound);
      this.outbound = [];
    }

    this.flush();

    if (now - this.lastMetricsAt >= METRICS_MS) this.publish(now);
  };

  /** One write for the whole batch, newest first. */
  private flush(): void {
    if (this.pending.size === 0 || this.paused()) return;
    const started = performance.now();
    const batch = this.pending.drain().reverse();
    this.renderedTotal += batch.length;
    // ponytail: copy-and-cap instead of head/tail index arithmetic. At most one
    // copy of a 500-element array per frame; the index version is the same
    // bound with more ways to be wrong.
    this._items.update((items) => [...batch, ...items].slice(0, RETAIN));
    this.cpuMs += performance.now() - started;
  }

  /**
   * Rates are measured against the oldest reading still inside the window, not
   * against the previous tick. Server-sent events arrive in clumps — a 200ms
   * tick regularly catches an empty gap between clumps, which reads as a rate of
   * zero on a stream that is plainly running. A second of history smooths that
   * out without smoothing away a real change.
   */
  private publish(now: number): void {
    this.lastMetricsAt = now;
    this.samples.push({
      t: now,
      ingested: this.ingested,
      rendered: this.renderedTotal,
      renders: this.renders,
      cpuMs: this.cpuMs,
    });
    while (this.samples.length > 1 && now - this.samples[0].t > RATE_WINDOW_MS) {
      this.samples.shift();
    }

    // A single sample means the window just restarted — after a stall, or on the
    // very first tick. Report zero rather than a number divided by no time.
    const oldest = this.samples[0];
    const span = (now - oldest.t) / 1000;
    const rate = (current: number, before: number) => (span > 0 ? (current - before) / span : 0);

    this._metrics.set({
      ingestedPerSec: rate(this.ingested, oldest.ingested),
      renderedPerSec: rate(this.renderedTotal, oldest.rendered),
      rendersPerSec: rate(this.renders, oldest.renders),
      cpuMsPerSec: rate(this.cpuMs, oldest.cpuMs),
      retained: this._items().length,
      dropped: this.droppedTotal + this.pending.dropped,
      bufferPeak: this.pending.peak,
      frameAvgMs: this.frames > 0 ? this.frameSum / this.frames : 0,
      frameWorstMs: this.frameWorst,
      wireTotal: this.stream.received,
    });

    // Frame timing and buffer depth are peaks and averages, so they get the same
    // one-second window as the rates rather than a fresh 200ms one.
    if (now - this.windowAt >= RATE_WINDOW_MS) {
      this.windowAt = now;
      this.pending.resetPeak();
      this.frames = 0;
      this.frameSum = 0;
      this.frameWorst = 0;
    }
  }
}
