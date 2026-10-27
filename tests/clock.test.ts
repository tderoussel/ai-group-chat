import { describe, expect, it } from 'vitest';
import { localDate } from '../src/clock.js';

describe('localDate', () => {
  it('uses the calendar date in New York, not the UTC one', () => {
    expect(localDate(new Date('2026-10-23T03:59:59Z'), 'America/New_York')).toBe('2026-10-22');
    expect(localDate(new Date('2026-10-23T04:00:00Z'), 'America/New_York')).toBe('2026-10-23');
  });
  it('follows the end of daylight saving time in New York (1 Nov 2026)', () => {
    expect(localDate(new Date('2026-11-02T04:30:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(localDate(new Date('2026-11-02T05:00:00Z'), 'America/New_York')).toBe('2026-11-02');
  });
  it('gives the UTC calendar date for UTC', () => {
    expect(localDate(new Date('2026-10-23T03:59:59Z'), 'UTC')).toBe('2026-10-23');
    expect(localDate(new Date('2026-10-23T23:59:59Z'), 'UTC')).toBe('2026-10-23');
    expect(localDate(new Date('2026-10-24T00:00:00Z'), 'UTC')).toBe('2026-10-24');
  });
  it('works for a zone ahead of UTC, and keeps zones apart when they alternate (formatters are cached per zone)', () => {
    const instant = new Date('2026-10-23T15:30:00Z');
    expect(localDate(instant, 'Asia/Tokyo')).toBe('2026-10-24');
    expect(localDate(instant, 'America/New_York')).toBe('2026-10-23');
    expect(localDate(instant, 'Asia/Tokyo')).toBe('2026-10-24');
    expect(localDate(instant, 'UTC')).toBe('2026-10-23');
  });
  it('follows the end of daylight saving time in London (25 Oct 2026)', () => {
    expect(localDate(new Date('2026-10-24T23:30:00Z'), 'Europe/London')).toBe('2026-10-25');
    expect(localDate(new Date('2026-10-25T23:30:00Z'), 'Europe/London')).toBe('2026-10-25');
    expect(localDate(new Date('2026-10-26T00:00:00Z'), 'Europe/London')).toBe('2026-10-26');
  });
});
