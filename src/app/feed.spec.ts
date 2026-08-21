import { TestBed } from '@angular/core/testing';
import { Feed, PENDING_MAX, RETAIN, toFeedItem } from './feed';
import { RECORDED } from './fixtures/recorded';
import { WikiStream, type RecentChange } from './wiki-stream';

/**
 * Stands in for the real service so nothing here opens a connection. Only the
 * two members {@link Feed} touches are implemented.
 */
class StreamStub {
  received = 0;
  sink: (change: RecentChange) => void = () => {};

  /** Replays recorded events in order, wrapping when it runs out. */
  emit(count: number, from = 0): void {
    for (let i = 0; i < count; i++) {
      this.received++;
      this.sink(RECORDED[(from + i) % RECORDED.length]);
    }
  }
}

/** One animation frame at 60 Hz. Sinon's fake rAF fires on a 16 ms cadence. */
const FRAME_MS = 16;

function frames(n: number): void {
  vi.advanceTimersByTime(FRAME_MS * n);
}

describe('toFeedItem', () => {
  it('reads the byte delta out of the length pair', () => {
    const change = { ...RECORDED[0], length: { old: 100, new: 180 } } as RecentChange;
    expect(toFeedItem(change, 7, 1234).delta).toBe(80);
    expect(toFeedItem(change, 7, 1234).seq).toBe(7);
    expect(toFeedItem(change, 7, 1234).t).toBe(1234);
  });

  it('treats a missing or null page length as zero instead of NaN', () => {
    const base = RECORDED[0];
    expect(toFeedItem({ ...base, length: undefined }, 0, 0).delta).toBe(0);
    expect(toFeedItem({ ...base, length: { old: null, new: 40 } }, 0, 0).delta).toBe(40);
    expect(toFeedItem({ ...base, length: { old: 40 } }, 0, 0).delta).toBe(-40);
  });

  it('maps every recorded event without producing a NaN delta', () => {
    const items = RECORDED.map((change, i) => toFeedItem(change, i, 0));
    expect(items).toHaveLength(300);
    expect(items.every((item) => Number.isFinite(item.delta))).toBe(true);
    expect(items.every((item) => item.wiki.length > 0)).toBe(true);
  });
});

describe('Feed flush cadence', () => {
  let stream: StreamStub;
  let feed: Feed;

  beforeEach(() => {
    // Only the frame clock is faked. Angular's scheduler runs on microtasks and
    // setTimeout; faking those deadlocks the test rather than controlling it.
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
    stream = new StreamStub();
    TestBed.configureTestingModule({
      providers: [{ provide: WikiStream, useValue: stream as unknown as WikiStream }],
    });
    // Feed schedules its first frame in the constructor, so the fake clock has
    // to be installed before this line.
    feed = TestBed.inject(Feed);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('writes nothing at all while events are arriving between frames', () => {
    const before = feed.items();
    stream.emit(50);
    // Reference equality, not length: a write per event would replace the array
    // even if the contents ended up the same.
    expect(feed.items()).toBe(before);
    expect(before).toHaveLength(0);
  });

  it('publishes the whole batch on the next frame, in one write, newest first', () => {
    const before = feed.items();
    stream.emit(50);
    frames(1);

    const after = feed.items();
    expect(after).not.toBe(before);
    expect(after).toHaveLength(50);
    expect(after[0].seq).toBe(49);
    expect(after[49].seq).toBe(0);
  });

  it('does not write again on a frame with nothing buffered', () => {
    stream.emit(10);
    frames(1);
    const after = feed.items();

    frames(5);
    expect(feed.items()).toBe(after);
  });

  it('writes once per frame, not once per event', () => {
    let writes = 0;
    let previous = feed.items();
    for (let i = 0; i < 10; i++) {
      stream.emit(20, i * 20);
      frames(1);
      if (feed.items() !== previous) writes++;
      previous = feed.items();
    }

    expect(writes).toBe(10);
    expect(feed.items()).toHaveLength(200);
  });

  it('keeps at most RETAIN rows however much arrives', () => {
    for (let i = 0; i < 4; i++) {
      stream.emit(PENDING_MAX);
      frames(1);
    }

    expect(feed.items()).toHaveLength(RETAIN);
    // The newest survives, the oldest does not.
    expect(feed.items()[0].seq).toBe(4 * PENDING_MAX - 1);
  });

  it('drops the oldest buffered events past capacity and reports the count', () => {
    stream.emit(PENDING_MAX + 25);
    frames(1);
    // Metrics publish on a 200 ms cadence, so give the panel a chance to update.
    frames(16);

    // The 25 oldest never made it: the buffer holds PENDING_MAX and the feed
    // then keeps the newest RETAIN of those.
    expect(feed.metrics().dropped).toBe(25);
    expect(feed.items()).toHaveLength(RETAIN);
    expect(feed.items()[RETAIN - 1].seq).toBe(PENDING_MAX + 25 - RETAIN);
  });

  it('freezes the feed while paused and keeps counting what it loses', () => {
    stream.emit(10);
    frames(1);
    const shown = feed.items();

    feed.paused.set(true);
    stream.emit(PENDING_MAX + 40);
    frames(16);

    expect(feed.items()).toBe(shown);
    expect(feed.metrics().dropped).toBe(40);
    expect(feed.metrics().bufferPeak).toBe(PENDING_MAX);

    feed.paused.set(false);
    frames(1);
    expect(feed.items()).not.toBe(shown);
    expect(feed.items()).toHaveLength(RETAIN);
  });

  it('renders immediately, once per event, with backpressure off', () => {
    feed.backpressure.set(false);
    const before = feed.items();

    stream.emit(3);
    expect(feed.items()).not.toBe(before);
    expect(feed.items()).toHaveLength(3);
    expect(feed.metrics().dropped).toBe(0);
  });

  it('multiplies each wire event by the synthetic load factor', () => {
    feed.stress.set(10);
    stream.emit(5);
    frames(16);

    expect(feed.items()).toHaveLength(50);
    // The panel separates the real wire rate from the load it is being put under.
    expect(feed.metrics().wireTotal).toBe(5);
    expect(feed.metrics().retained).toBe(50);
  });
});
