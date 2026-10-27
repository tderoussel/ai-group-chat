import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Settings, SettingsError } from '../src/settings.js';

describe('Settings', () => {
  it('reads the defaults', () => {
    expect(new Settings(openDb(':memory:')).get()).toEqual({ reply_budget: 8, max_handoffs: 3, daily_cap: 60 });
  });
  it('updates within the bounds and saves nothing when any value is wrong', () => {
    const s = new Settings(openDb(':memory:'));
    expect(s.update({ reply_budget: 12 })).toEqual({ reply_budget: 12, max_handoffs: 3, daily_cap: 60 });
    expect(s.update({ max_handoffs: 0 }).max_handoffs).toBe(0);
    expect(() => s.update({ reply_budget: 0 })).toThrow(SettingsError);
    expect(() => s.update({ daily_cap: 501 })).toThrow(/1 to 500/);
    expect(() => s.update({ max_handoffs: 1.5 })).toThrow(SettingsError);
    expect(() => s.update({ reply_budget: 9, nope: 1 } as never)).toThrow(/Unknown/);
    expect(s.get()).toEqual({ reply_budget: 12, max_handoffs: 0, daily_cap: 60 });
  });
});
