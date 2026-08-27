import { TestBed } from '@angular/core/testing';
import { RECORDED } from './fixtures/recorded';
import {
  MAX_ATTEMPTS,
  WikiStream,
  backoffDelay,
  isRecentChange,
  type RecentChange,
} from './wiki-stream';

describe('backoffDelay', () => {
  it('grows exponentially and caps at 30s', () => {
    const max = (attempt: number) => backoffDelay(attempt, () => 1);
    expect(max(1)).toBe(1_000);
    expect(max(2)).toBe(2_000);
    expect(max(3)).toBe(4_000);
    expect(max(10)).toBe(30_000);
    expect(max(50)).toBe(30_000);
  });

  it('jitters down to zero so clients do not reconnect in lockstep', () => {
    expect(backoffDelay(5, () => 0)).toBe(0);
    expect(backoffDelay(5, () => 0.5)).toBe(8_000);
  });
});

describe('isRecentChange', () => {
  it('accepts every payload in the recorded fixture', () => {
    expect(RECORDED).toHaveLength(300);
    expect(RECORDED.every(isRecentChange)).toBe(true);
  });

  it('rejects anything that is not a change, without throwing', () => {
    const good = RECORDED[0];
    expect(isRecentChange(null)).toBe(false);
    expect(isRecentChange(undefined)).toBe(false);
    expect(isRecentChange('edit')).toBe(false);
    expect(isRecentChange(42)).toBe(false);
    expect(isRecentChange([good])).toBe(false);
    expect(isRecentChange({ ...good, title: undefined })).toBe(false);
    expect(isRecentChange({ ...good, server_name: 12 })).toBe(false);
  });
});

/**
 * Stands in for the browser's EventSource so nothing here opens a socket. The
 * test plays the server: it calls the handlers the service attached.
 */
class FakeEventSource {
  static opened: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  close(): void {
    this.closed = true;
  }

  /** The connection the service is currently holding. */
  static get last(): FakeEventSource {
    return FakeEventSource.opened[FakeEventSource.opened.length - 1];
  }
}

describe('WikiStream connection', () => {
  let stream: WikiStream;

  /** Runs the pending reconnect timer and reports how long it waited. */
  function runReconnect(): number {
    const before = Date.now();
    vi.advanceTimersToNextTimer();
    return Date.now() - before;
  }

  function message(data: string): void {
    FakeEventSource.last.onmessage!({ data } as MessageEvent<string>);
  }

  beforeEach(() => {
    FakeEventSource.opened = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    // Full jitter picks a point in [0, ceiling]; pinning random() to the top
    // makes the scheduled delay the exact figure the backoff curve promises.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    // Date is faked alongside the timers so a reconnect's wait can be measured
    // off the clock instead of guessed at.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    TestBed.configureTestingModule({});
    // The service connects in its constructor, so the fakes go in first.
    stream = TestBed.inject(WikiStream);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens the recentchange stream on construction', () => {
    expect(FakeEventSource.opened).toHaveLength(1);
    expect(FakeEventSource.last.url).toContain('/v2/stream/recentchange');
    expect(stream.status()).toBe('connecting');
    expect(stream.connected()).toBe(false);
  });

  it('goes live when the connection opens', () => {
    FakeEventSource.last.onopen!();

    expect(stream.status()).toBe('live');
    expect(stream.connected()).toBe(true);
    expect(stream.attempt()).toBe(0);
  });

  it('takes the connection down itself and doubles the wait on every failure', () => {
    const first = FakeEventSource.last;
    first.onerror!();

    // EventSource would retry on its own with no backoff, so the service has to
    // close it and detach the handlers before scheduling anything.
    expect(first.closed).toBe(true);
    expect(first.onmessage).toBeNull();
    expect(stream.status()).toBe('reconnecting');
    expect(stream.attempt()).toBe(1);

    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      waits.push(runReconnect());
      FakeEventSource.last.onerror!();
    }

    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(FakeEventSource.opened).toHaveLength(5);
  });

  it('keeps every jittered wait inside [0, min(30s, 500ms * 2^attempt)]', () => {
    const randoms = [0, 0.25, 1, 0.5, 0.99, 0, 1];
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => randoms[i++]);

    const waits: number[] = [];
    for (let attempt = 1; attempt <= randoms.length; attempt++) {
      FakeEventSource.last.onerror!();
      expect(stream.attempt()).toBe(attempt);

      const waited = runReconnect();
      waits.push(waited);
      expect(waited).toBeGreaterThanOrEqual(0);
      expect(waited).toBeLessThanOrEqual(Math.min(30_000, 500 * 2 ** attempt));
    }

    // A jitter of 0 means an immediate retry, and the last attempt's uncapped
    // ceiling would be 64s — the cap, not the curve, decides it.
    expect(waits[0]).toBe(0);
    expect(waits.at(-1)).toBe(30_000);
  });

  it('resets the backoff once a connection actually opens', () => {
    FakeEventSource.last.onerror!();
    runReconnect();
    FakeEventSource.last.onerror!();
    expect(stream.attempt()).toBe(2);
    expect(runReconnect()).toBe(2_000);

    FakeEventSource.last.onopen!();
    expect(stream.attempt()).toBe(0);
    expect(stream.status()).toBe('live');

    // A later drop starts the curve at its first step again, not at 4s.
    FakeEventSource.last.onerror!();
    expect(stream.attempt()).toBe(1);
    expect(runReconnect()).toBe(1_000);
  });

  it('gives up after MAX_ATTEMPTS failures and stops scheduling', () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      FakeEventSource.last.onerror!();
      runReconnect();
    }
    expect(stream.status()).toBe('reconnecting');

    FakeEventSource.last.onerror!();
    expect(stream.status()).toBe('failed');
    expect(stream.attempt()).toBe(MAX_ATTEMPTS);

    const opened = FakeEventSource.opened.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeEventSource.opened).toHaveLength(opened);
  });

  it('reconnects from failed on restart, with the backoff cleared', () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      FakeEventSource.last.onerror!();
      runReconnect();
    }
    FakeEventSource.last.onerror!();
    expect(stream.status()).toBe('failed');

    stream.restart();
    expect(stream.attempt()).toBe(0);
    expect(stream.status()).toBe('connecting');

    FakeEventSource.last.onopen!();
    expect(stream.status()).toBe('live');
  });

  it('forwards a well-formed payload to the sink once', () => {
    const seen: RecentChange[] = [];
    stream.sink = (change) => seen.push(change);
    FakeEventSource.last.onopen!();

    message(JSON.stringify(RECORDED[0]));

    expect(seen).toHaveLength(1);
    expect(seen[0].title).toBe(RECORDED[0].title);
    expect(stream.received).toBe(1);
    expect(stream.malformed()).toBe(0);
  });

  it('counts and discards anything that is not a recent change, without dropping the stream', () => {
    const seen: RecentChange[] = [];
    stream.sink = (change) => seen.push(change);
    const source = FakeEventSource.last;
    source.onopen!();

    message('not json at all');
    message('{"broken":');
    message('null');
    message(JSON.stringify({ type: 'edit', title: 'Main Page' })); // no server_name
    message(JSON.stringify([RECORDED[0]]));

    expect(stream.malformed()).toBe(5);
    expect(stream.received).toBe(0);
    expect(seen).toHaveLength(0);
    // A bad frame must not take the connection down with it.
    expect(stream.status()).toBe('live');
    expect(source.closed).toBe(false);

    message(JSON.stringify(RECORDED[1]));
    expect(seen).toHaveLength(1);
    expect(stream.malformed()).toBe(5);
  });

  it('closes the connection when its injector is destroyed', () => {
    const source = FakeEventSource.last;
    FakeEventSource.last.onerror!();
    expect(vi.getTimerCount()).toBe(1);

    TestBed.resetTestingModule();

    expect(source.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
