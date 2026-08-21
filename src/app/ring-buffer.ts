/**
 * Fixed-capacity FIFO over a preallocated array. Pushing into a full buffer
 * overwrites the oldest item and counts it as a drop.
 *
 * Dropping is the point. This sits between a stream nobody can slow down and a
 * renderer that can only paint sixty times a second, so when more arrives than
 * can be shown, something has to go. The choice is which end loses and whether
 * anyone is told — here it is the oldest events, and the count is on screen.
 *
 * The circular indices are what keep an overflowing push O(1); shifting a plain
 * array would move every remaining element on every dropped event, which at a
 * few thousand events a second is exactly the cost this class exists to avoid.
 */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  /** Index of the oldest item. */
  private head = 0;
  private count = 0;
  private _dropped = 0;
  private _peak = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.slots = new Array<T | undefined>(capacity);
  }

  /** Items currently held. */
  get size(): number {
    return this.count;
  }

  /** Items overwritten because the buffer was full. Cumulative, never reset. */
  get dropped(): number {
    return this._dropped;
  }

  /** Deepest the buffer has been since the last {@link resetPeak}. */
  get peak(): number {
    return this._peak;
  }

  push(item: T): void {
    if (this.count === this.capacity) {
      this.slots[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      this._dropped++;
      return;
    }
    this.slots[(this.head + this.count) % this.capacity] = item;
    this.count++;
    if (this.count > this._peak) this._peak = this.count;
  }

  /** Take everything held, oldest first, leaving the buffer empty. */
  drain(): T[] {
    const out = new Array<T>(this.count);
    for (let i = 0; i < this.count; i++) {
      const slot = (this.head + i) % this.capacity;
      out[i] = this.slots[slot] as T;
      // Release the reference: a drained buffer must not pin the batch it just
      // handed over, or the "bounded memory" claim is only half true.
      this.slots[slot] = undefined;
    }
    this.head = 0;
    this.count = 0;
    return out;
  }

  /** Start a new peak window at the current depth. */
  resetPeak(): void {
    this._peak = this.count;
  }
}
