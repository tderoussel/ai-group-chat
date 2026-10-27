/** At most `max` calls per key in each fixed window of `windowMs`. In memory: the app runs as one instance. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}

  take(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.prune(t);
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    if (w.count >= this.max) return false;
    w.count += 1;
    return true;
  }

  private prune(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
