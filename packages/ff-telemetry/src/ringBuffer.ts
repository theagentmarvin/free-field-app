// Fixed-capacity circular overwrite buffer.
//
// The "ring buffer" crown jewel: a bounded history where the
// oldest entry is dropped once the capacity is reached. `toArray()`
// always returns oldest → newest, which is what the error bundle
// needs when reconstructing "what led up to this".

export class RingBuffer<T> {
  private items: T[] = [];

  private readonly capacity: number;

  constructor(capacity: number) {
    // A non-positive capacity would make the buffer useless and
    // `push` would delete everything every time. Clamp to a sane
    // floor so a bad config can't turn telemetry into a foot-gun.
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? capacity : 1;
  }

  /** Append `item`. Drops the oldest entry when over capacity. */
  push(item: T): void {
    this.items.push(item);
    const overflow = this.items.length - this.capacity;
    if (overflow > 0) {
      this.items.splice(0, overflow);
    }
  }

  /** A copy of the buffered items, oldest → newest. */
  toArray(): T[] {
    return [...this.items];
  }

  /** Empty the buffer. */
  clear(): void {
    this.items = [];
  }
}