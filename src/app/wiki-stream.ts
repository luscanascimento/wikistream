import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

/** https://stream.wikimedia.org/v2/stream/recentchange — public, keyless, CORS-open. */
const ENDPOINT = 'https://stream.wikimedia.org/v2/stream/recentchange';

/** Give up after this many consecutive failed connection attempts. */
export const MAX_ATTEMPTS = 8;

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'failed';

/**
 * The fields of the mediawiki/recentchange schema this app actually reads.
 * The payload carries more; anything not listed here is ignored on purpose.
 */
export interface RecentChange {
  readonly id: number;
  readonly type: 'edit' | 'new' | 'log' | 'categorize' | (string & {});
  readonly title: string;
  readonly user: string;
  readonly bot: boolean;
  readonly minor?: boolean;
  readonly comment: string;
  readonly namespace: number;
  readonly timestamp: number;
  readonly wiki: string;
  readonly server_name: string;
  readonly length?: { old?: number | null; new?: number | null };
  readonly meta: { dt: string; domain: string };
}

/**
 * Exponential backoff with full jitter, capped at 30s.
 * Jitter matters here: every client of a public firehose gets dropped at the
 * same instant, so a fixed schedule would reconnect them all in lockstep.
 */
export function backoffDelay(attempt: number, random = Math.random): number {
  return Math.round(random() * Math.min(30_000, 500 * 2 ** attempt));
}

/** Minimum viable shape check before a payload is trusted as a RecentChange. */
export function isRecentChange(value: unknown): value is RecentChange {
  const c = value as RecentChange | null;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.type === 'string' &&
    typeof c.title === 'string' &&
    typeof c.server_name === 'string'
  );
}

@Injectable({ providedIn: 'root' })
export class WikiStream {
  private readonly _status = signal<StreamStatus>('connecting');
  private readonly _malformed = signal(0);
  private readonly _attempt = signal(0);

  /** connecting -> live -> reconnecting -> live ... -> failed */
  readonly status = this._status.asReadonly();
  /** Payloads the server sent that did not parse as a recent change. */
  readonly malformed = this._malformed.asReadonly();
  /** Consecutive failed connection attempts; resets to 0 on every open. */
  readonly attempt = this._attempt.asReadonly();
  readonly connected = computed(() => this._status() === 'live');

  /**
   * Events parsed off the wire since the page loaded. A plain field, not a
   * signal: at 30-100 events/second a signal write here would schedule one
   * change detection pass per event, which is the exact problem the pipeline
   * downstream exists to solve. Readers sample it on their own cadence.
   */
  received = 0;

  /**
   * Where parsed events go. Set by whoever owns the rendering pipeline; a
   * single consumer is all this app has, so there is no subscriber list.
   */
  sink: (change: RecentChange) => void = () => {};

  private source: EventSource | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
    this.open();
  }

  /** Tear down the connection. Safe to call twice. */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Detach handlers first: close() alone does not stop an in-flight error.
    if (this.source) {
      this.source.onopen = this.source.onmessage = this.source.onerror = null;
      this.source.close();
      this.source = null;
    }
  }

  /** Reconnect immediately, resetting the backoff. Use after 'failed'. */
  restart(): void {
    this.stop();
    this._attempt.set(0);
    this.open();
  }

  private open(): void {
    this.stop();
    this._status.set(this._attempt() === 0 ? 'connecting' : 'reconnecting');

    const source = new EventSource(ENDPOINT);
    this.source = source;

    source.onopen = () => {
      this._attempt.set(0);
      this._status.set('live');
    };

    source.onmessage = (event: MessageEvent<string>) => {
      // Anything off the wire is untrusted: a bad frame must not kill the stream.
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        this._malformed.update((n) => n + 1);
        return;
      }
      if (!isRecentChange(payload)) {
        this._malformed.update((n) => n + 1);
        return;
      }
      this.received++;
      this.sink(payload);
    };

    source.onerror = () => {
      // EventSource reconnects on its own with no backoff, which hammers the
      // endpoint during an outage. Take the connection down and schedule it.
      this.stop();

      const attempt = this._attempt() + 1;
      this._attempt.set(attempt);

      if (attempt >= MAX_ATTEMPTS) {
        this._status.set('failed');
        return;
      }

      this._status.set('reconnecting');
      this.timer = setTimeout(() => this.open(), backoffDelay(attempt));
    };
  }
}
