/**
 * Bounded ingest queue. WebSocket callbacks only enqueue; publish loop drains.
 */
export type QueueDropReason = "capacity" | "superseded";

export class BoundedQueue<T> {
  private readonly items: T[] = [];
  dropped = 0;

  constructor(
    private readonly capacity: number,
    private readonly onDrop?: (item: T, reason: QueueDropReason) => void,
  ) {}

  get size(): number {
    return this.items.length;
  }

  /**
   * Push with optional merge key. When full and mergeKey is set, replace the
   * newest matching item (ORDERBOOK coalesce) instead of dropping FIFO head.
   */
  enqueue(item: T, opts?: { mergeKey?: string; keyOf?: (item: T) => string }): boolean {
    if (opts?.mergeKey && opts.keyOf) {
      for (let i = this.items.length - 1; i >= 0; i--) {
        if (opts.keyOf(this.items[i]!) === opts.mergeKey) {
          const prev = this.items[i]!;
          this.items[i] = item;
          this.onDrop?.(prev, "superseded");
          this.dropped += 1;
          return true;
        }
      }
    }
    if (this.items.length >= this.capacity) {
      const dropped = this.items.shift();
      if (dropped) {
        this.dropped += 1;
        this.onDrop?.(dropped, "capacity");
      }
    }
    this.items.push(item);
    return true;
  }

  drain(max: number): T[] {
    const n = Math.min(max, this.items.length);
    return this.items.splice(0, n);
  }
}
