# WikiStream

> **Node 22.22.3 exactly** — Angular 22's CLI rejects older 22.x releases, so
> `nvm use` (the version is in `.nvmrc`) before `npm install`. See
> [Running it](#running-it).

A firehose you can watch without drowning.

Every edit, page creation and log action across all Wikimedia wikis arrives on
[one public stream](https://stream.wikimedia.org/v2/stream/recentchange) — no key,
no signup, CORS open, so this runs entirely in the browser with no backend. The
hard part is not reading the stream. It is staying at 60 fps for hours while it
runs, and being able to _show_ that you are.

The instrument strip across the top reports what the pipeline is actually doing:
events in per second, rows rendered per second, change detection passes per
second, main-thread milliseconds burnt per second, rows retained, events dropped,
peak buffer depth, mean and worst frame. Every number is measured — render passes
come from Angular's `afterEveryRender` hook, frame times from
`requestAnimationFrame` deltas. Two switches, **synthetic load** (×1 to ×250) and
**backpressure**, let you push the pipeline and watch it hold.

## Backpressure

```
EventSource ──▶ ring buffer ──▶ rAF flush ──▶ one signal write ──▶ virtual scroll
     │           (1 000)         (≤60/s)                              (CDK)
     └──────────▶ batch ──▶ Web Worker ──▶ snapshot every 250 ms ──▶ aggregates
```

Server-sent events arrive in clumps, each in its own task. A signal write per
event asks for a change detection pass per event, so events instead land in a
fixed-capacity ring buffer and one animation frame flushes the whole batch with a
single write. Render work is then bounded by the display refresh rate no matter
how fast the upstream runs. Aggregation (per-wiki counts, bot split, size
histogram, busiest pages, rate history) happens in a Web Worker that answers on
its own 250 ms cadence rather than at the event rate; the main thread only paints.
The feed is a CDK virtual scroll viewport, so 500 retained rows cost about a dozen
DOM elements.

Measured in headless Chromium on an M-series Mac, ×100 synthetic load, three
alternating rounds of 11 s:

|                         | backpressure on  | backpressure off   |
| ----------------------- | ---------------- | ------------------ |
| Pipeline CPU            | **1 ms/s**       | **160 – 497 ms/s** |
| Rows retained           | 500              | 20 000             |
| Mean frame              | 16.6 – 16.7 ms   | 19.1 – 25.5 ms     |
| Change detection passes | 9 – 13 /s        | 9 – 12 /s          |
| Events ingested         | 5 400 – 6 200 /s | 2 500 – 6 900 /s   |

### How that table was measured, and what is missing from this repo

Every figure in it is one of the instrument strip's own counters, not a reading
from an external profiler:

- **Pipeline CPU** is the `ms/s` tile, fed by `cpuMsPerSec`. `FeedService.ingest`
  brackets the whole per-event loop with `performance.now()` and the panel
  divides the total by its one-second rate window.
- **Mean frame** is the average `requestAnimationFrame` delta over that same
  window. **Change detection passes** is a counter incremented by Angular's
  `afterEveryRender` hook, so it counts real passes rather than inferring them.
- **Rows retained** is the length of the rendered list, capped at `RETAIN` (500)
  with backpressure on and at `NAIVE_RETAIN` (20 000) with it off.

The run was headless Chromium on an M-series Mac, the synthetic load control at
×100, the backpressure switch alternated across three rounds of 11 s each —
which is why each cell is a range rather than one number.

**The harness that drove that run is not in this repository.** `tools/` holds
only `record-fixture.mjs`, which recorded the test fixture. So the table is a
reported measurement, not one you can reproduce with a single command from a
clean clone, and it was not re-measured when this note was written. What you can
do is reproduce it by hand, since the counters are the measurement: `npm start`,
set synthetic load to ×100, and toggle backpressure while watching the same
tiles. Treat the numbers as the shape of the result — two orders of magnitude —
rather than as figures to quote to a decimal.

**The result that surprised me:** change detection passes barely move. Angular's
zoneless scheduler already coalesces signal writes, so even 6 900 writes a second
collapse into about ten renders. The naive path is not painting more — it is doing
hundreds of times the work to paint the same thing, copying an ever-growing array
on every single event. The honest headline is not "one render per event", it is:
_render work is O(frames) either way; ingest work is O(events) unless you bound
it._

Two caveats a reviewer should know. The toggle moves two variables at once,
batching and retention, because with retention capped in both modes the naive path
measures fine on this hardware (2 ms/s against 124 ms/s of CPU, identical frame
times). And the naive path is capped at 20 000 rows so the tab stays recoverable;
without a cap the growth simply continues. The ingest column drifts because the
real wire rate drifts between rounds — roughly 25 to 70 events/second before the
multiplier — so the CPU and frame columns are the comparison.

## Dropping is the answer

The buffer between frames holds 1 000 events and the feed retains 500 rows. Both
overwrite the oldest when full, and both drops are counted on screen.

Nobody can slow Wikipedia down. There is no credit window to withhold and no
consumer offset to rewind, so the only lever left is which end loses data when
more arrives than can be shown. Buffering without a limit is not a third option —
it is dropping later, all at once, when the tab dies. Because this is a live view
of _now_, the oldest events are the ones worth losing, and the counter is what
turns a silent loss into a reported one: a pipeline whose drop rate you can read
is a pipeline you can size.

Pause the feed and you can watch the whole policy run — the buffer fills to 1 000,
the drop counter climbs, and memory does not move.

## Connection handling

`connecting → live → reconnecting → live … → failed`. The native `EventSource`
retries with no backoff at all, so during an outage every client in the world
reconnects in lockstep. On `error` the service closes the connection itself and
schedules a new one with exponential backoff and full jitter
(`random() * min(30s, 500ms * 2^attempt)`), giving up after 8 consecutive failures
and offering a manual retry. Every frame off the wire goes through `JSON.parse` in
a try/catch and then a shape check; a malformed payload increments a counter and is
discarded rather than taking the stream down.

## Tests

`src/app/fixtures/recentchange.ndjson` holds 300 consecutive events recorded off
the live stream, one raw payload per line, unedited. The tests replay that file,
so they run offline and deterministically — nothing in the test run or in CI opens
a socket. (`tools/record-fixture.mjs` is what recorded it, if it ever needs
refreshing.)

Covered: the ring buffer, including overflow, drop accounting and peak tracking;
the flush cadence, driven by a fake animation-frame clock, asserting on signal
identity that a batch of 50 events produces exactly zero writes before the frame
and exactly one after it; every aggregation function against the recorded data,
including that the result does not depend on how the stream was cut into batches;
the backoff curve and its jitter floor; and the payload shape check against all
300 real events.

## Everything else

Pause; filters by wiki and by bot/human, applied to the retained rows and not to
the aggregates, which always cover the whole stream; system, light and dark themes
from one set of `light-dark()` custom properties. The connection state is a live
region, the feed deliberately is not — announcing thirty rows a second makes the
page unusable with a screen reader — and the pulsing status dot respects
`prefers-reduced-motion`.

## Not in scope

No world map or spinning globe: the `recentchange` schema carries no geolocation,
and deriving a country from a language code would be a fabrication
(`en.wikipedia.org` is not "the United States"). No backend, no database, no auth.
History is not gapless across a reconnect either — the service opens a fresh
`EventSource` and loses `Last-Event-ID`; Wikimedia's `?since=` parameter is the fix
if that ever matters.

## Running it

Requires Node 22.22.3 (Angular 22's CLI rejects older 22.x releases). It is
pinned in `.nvmrc`:

```bash
nvm use          # 22.22.3
npm install
npm start        # http://localhost:4200
npm test         # vitest, single run
npm run build    # production bundle into dist/
```

Angular 22 (standalone, zoneless, signals), Angular CDK virtual scrolling,
TypeScript 6 strict, a Web Worker for aggregation, SCSS, Vitest.
