import { RingBuffer } from './ring-buffer';

describe('RingBuffer', () => {
  it('rejects a capacity it cannot honour', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(-1)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });

  it('drains in arrival order and leaves itself empty', () => {
    const buffer = new RingBuffer<number>(4);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);

    expect(buffer.size).toBe(3);
    expect(buffer.drain()).toEqual([1, 2, 3]);
    expect(buffer.size).toBe(0);
    expect(buffer.drain()).toEqual([]);
  });

  it('overwrites the oldest once full and counts every drop', () => {
    const buffer = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) buffer.push(n);

    expect(buffer.size).toBe(3);
    expect(buffer.dropped).toBe(2);
    expect(buffer.drain()).toEqual([3, 4, 5]);
    // Draining hands over the survivors; it does not forgive the drops.
    expect(buffer.dropped).toBe(2);
  });

  it('keeps its order after wrapping around the underlying array', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.drain()).toEqual([1, 2]);

    // The head is now mid-array; pushing past the end has to wrap cleanly.
    for (const n of [3, 4, 5, 6]) buffer.push(n);
    expect(buffer.drain()).toEqual([4, 5, 6]);
    expect(buffer.dropped).toBe(1);
  });

  it('never grows past its capacity, whatever the ratio of pushes to drains', () => {
    const buffer = new RingBuffer<number>(10);
    let drained = 0;
    for (let i = 0; i < 10_000; i++) {
      buffer.push(i);
      expect(buffer.size).toBeLessThanOrEqual(10);
      if (i % 37 === 0) drained += buffer.drain().length;
    }
    drained += buffer.drain().length;

    // Nothing is invented and nothing vanishes unaccounted for.
    expect(drained + buffer.dropped).toBe(10_000);
  });

  it('tracks the deepest it got, and starts a fresh window on request', () => {
    const buffer = new RingBuffer<number>(5);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(buffer.peak).toBe(3);

    buffer.drain();
    // The peak is the point of the reading, so it survives the buffer emptying.
    expect(buffer.peak).toBe(3);

    buffer.resetPeak();
    expect(buffer.peak).toBe(0);
    buffer.push(1);
    expect(buffer.peak).toBe(1);
  });

  it('caps the peak at capacity while it is overflowing', () => {
    const buffer = new RingBuffer<number>(4);
    for (let i = 0; i < 100; i++) buffer.push(i);

    expect(buffer.peak).toBe(4);
    expect(buffer.dropped).toBe(96);
  });

  it('lets go of drained items instead of pinning the last batch', () => {
    const buffer = new RingBuffer<object>(2);
    buffer.push({ marker: 'held' });
    expect(buffer.drain()).toEqual([{ marker: 'held' }]);

    // Not a garbage collection assertion, just that no slot still points at it.
    expect(JSON.stringify(buffer)).not.toContain('held');
  });
});
