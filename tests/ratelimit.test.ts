import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/ratelimit.js';

describe('RateLimiter', () => {
  it('allows max calls per window, per key, and resets with the next window', () => {
    let t = 0;
    const limiter = new RateLimiter(2, 1000, () => t);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([true, true, false]);
    expect(limiter.take('b')).toBe(true);
    t = 1000;
    expect(limiter.take('a')).toBe(true);
  });
});
