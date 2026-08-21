import {
  accumulate,
  createAccumulator,
  RATE_WINDOW_SEC,
  sizeBucket,
  snapshot,
  SIZE_BUCKETS,
  type AggEvent,
} from './aggregate';
import { toFeedItem } from './feed';
import { RECORDED } from './fixtures/recorded';

/** Second 1700000000, so every offset below is readable as "ms into the sample". */
const T = 1_700_000_000_000;

function event(
  wiki: string,
  bot: boolean,
  type: string,
  title: string,
  delta: number,
  offset: number,
): AggEvent {
  return { wiki, bot, type, title, delta, t: T + offset };
}

/** Twelve events over four seconds, three per second. */
const FIXTURE: AggEvent[] = [
  event('en.wikipedia.org', false, 'edit', 'Main Page', 50, 0),
  event('en.wikipedia.org', true, 'edit', 'Main Page', -1200, 100),
  event('en.wikipedia.org', false, 'new', 'Cats', 2000, 200),
  event('de.wikipedia.org', true, 'edit', 'Katzen', 0, 1000),
  event('de.wikipedia.org', true, 'log', 'Katzen', 0, 1100),
  event('fr.wikipedia.org', false, 'edit', 'Chats', -50, 1200),
  event('en.wikipedia.org', false, 'edit', 'Cats', 150, 2000),
  event('commons.wikimedia.org', true, 'categorize', 'File:X', 0, 2100),
  event('en.wikipedia.org', true, 'edit', 'Main Page', -100, 2200),
  event('fr.wikipedia.org', false, 'edit', 'Chats', 999, 3000),
  event('www.wikidata.org', true, 'edit', 'Q42', 1000, 3100),
  event('en.wikipedia.org', false, 'edit', 'Dogs', -1, 3200),
];

function fixtureStats(now = T + 4000) {
  const acc = createAccumulator();
  accumulate(acc, FIXTURE);
  return snapshot(acc, now);
}

describe('sizeBucket', () => {
  it('puts every delta in exactly one bucket, edges included', () => {
    expect(sizeBucket(-5000)).toBe(0);
    expect(sizeBucket(-1000)).toBe(0);
    expect(sizeBucket(-999)).toBe(1);
    expect(sizeBucket(-100)).toBe(1);
    expect(sizeBucket(-99)).toBe(2);
    expect(sizeBucket(-1)).toBe(2);
    expect(sizeBucket(0)).toBe(3);
    expect(sizeBucket(1)).toBe(4);
    expect(sizeBucket(99)).toBe(4);
    expect(sizeBucket(100)).toBe(5);
    expect(sizeBucket(999)).toBe(5);
    expect(sizeBucket(1000)).toBe(6);
  });
});

describe('aggregation over a fixture', () => {
  it('splits bots from humans', () => {
    const stats = fixtureStats();
    expect(stats.total).toBe(12);
    expect(stats.bots).toBe(6);
    expect(stats.humans).toBe(6);
    expect(stats.bots + stats.humans).toBe(stats.total);
  });

  it('ranks wikis by count, breaking ties on name so the panel does not flicker', () => {
    expect(fixtureStats().topWikis).toEqual([
      { key: 'en.wikipedia.org', count: 6 },
      { key: 'de.wikipedia.org', count: 2 },
      { key: 'fr.wikipedia.org', count: 2 },
      { key: 'commons.wikimedia.org', count: 1 },
      { key: 'www.wikidata.org', count: 1 },
    ]);
  });

  it('ranks pages the same way', () => {
    expect(fixtureStats().topPages.slice(0, 4)).toEqual([
      { key: 'Main Page', count: 3 },
      { key: 'Cats', count: 2 },
      { key: 'Chats', count: 2 },
      { key: 'Katzen', count: 2 },
    ]);
  });

  it('counts every event into the size histogram exactly once', () => {
    const stats = fixtureStats();
    expect(stats.sizeBuckets).toEqual([1, 1, 2, 3, 1, 2, 2]);
    expect(stats.sizeBuckets).toHaveLength(SIZE_BUCKETS.length);
    expect(stats.sizeBuckets.reduce((a, b) => a + b, 0)).toBe(stats.total);
  });

  it('counts event types', () => {
    expect(fixtureStats().byType).toEqual([
      { key: 'edit', count: 9 },
      { key: 'categorize', count: 1 },
      { key: 'log', count: 1 },
      { key: 'new', count: 1 },
    ]);
  });

  it('buckets the rate per second and averages only completed seconds', () => {
    const stats = fixtureStats();
    expect(stats.perSecond).toHaveLength(60);
    // The window ends on the second the snapshot was taken, which is still empty.
    expect(stats.perSecond.slice(-6)).toEqual([0, 3, 3, 3, 3, 0]);
    // Five completed seconds: one silent, four with three events each.
    expect(stats.ratePerSec).toBe(2.4);
  });

  it('forgets rate buckets that fell out of the window', () => {
    const acc = createAccumulator();
    accumulate(acc, FIXTURE);
    const stats = snapshot(acc, T + 120_000);
    expect(acc.perSecond.size).toBe(0);
    expect(stats.perSecond.every((n) => n === 0)).toBe(true);
    expect(stats.ratePerSec).toBe(0);
    // Totals are cumulative and survive the window sliding past.
    expect(stats.total).toBe(12);
  });
});

describe('aggregation over 300 recorded events', () => {
  /** Recorded payloads, spread one every 10 ms so they fall across three seconds. */
  const events = RECORDED.map((change, i) => toFeedItem(change, i, T + i * 10));
  const now = T + events.length * 10;

  function statsFor(batches: readonly (readonly AggEvent[])[]) {
    const acc = createAccumulator();
    for (const batch of batches) accumulate(acc, batch);
    return snapshot(acc, now);
  }

  const stats = statsFor([events]);

  it('agrees with a straightforward recount of the same file', () => {
    const wikis = new Map<string, number>();
    let bots = 0;
    for (const event of events) {
      if (event.bot) bots++;
      wikis.set(event.wiki, (wikis.get(event.wiki) ?? 0) + 1);
    }
    const expected = [...wikis]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, 8);

    expect(stats.total).toBe(300);
    expect(stats.bots).toBe(bots);
    expect(stats.humans).toBe(300 - bots);
    expect(stats.topWikis).toEqual(expected);
  });

  it('counts every event into exactly one size bucket and one second', () => {
    expect(stats.sizeBuckets.reduce((a, b) => a + b, 0)).toBe(300);
    expect(stats.perSecond).toHaveLength(RATE_WINDOW_SEC);
    expect(stats.perSecond.reduce((a, b) => a + b, 0)).toBe(300);
    expect(stats.byType.reduce((sum, entry) => sum + entry.count, 0)).toBe(300);
  });

  it('gives the same answer however the stream was cut into batches', () => {
    const oneAtATime = events.map((event) => [event]);
    const uneven = [
      events.slice(0, 7),
      events.slice(7, 8),
      events.slice(8, 199),
      events.slice(199),
    ];

    // The pipeline hands the worker whatever arrived since the last frame, so a
    // result that depended on the batch boundaries would drift with the load.
    expect(statsFor(oneAtATime)).toEqual(stats);
    expect(statsFor(uneven)).toEqual(stats);
  });

  it('ranks pages with counts that add up to no more than the total', () => {
    const pages = stats.topPages;
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.reduce((sum, entry) => sum + entry.count, 0)).toBeLessThanOrEqual(300);
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i - 1].count).toBeGreaterThanOrEqual(pages[i].count);
    }
  });
});

describe('page table pruning', () => {
  it('stays bounded under unbounded page cardinality, keeping the heavy hitters', () => {
    const acc = createAccumulator();
    const hot = Array.from({ length: 20 }, () =>
      event('en.wikipedia.org', false, 'edit', 'Hot', 1, 0),
    );
    accumulate(acc, hot);
    for (let i = 0; i < 6_000; i++) {
      accumulate(acc, [event('en.wikipedia.org', false, 'edit', `Page ${i}`, 1, 0)]);
    }

    expect(acc.byPage.size).toBeLessThanOrEqual(5_000);
    expect(acc.byPage.get('Hot')).toBe(20);
    expect(snapshot(acc, T).topPages[0]).toEqual({ key: 'Hot', count: 20 });
    // Pruning drops keys, never counts: the running total is still exact.
    expect(acc.total).toBe(6_020);
  });
});
