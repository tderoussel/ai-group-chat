import type { Db } from './db.js';

export type Limits = { reply_budget: number; max_handoffs: number; daily_cap: number };

export class SettingsError extends Error {}

const BOUNDS: Record<keyof Limits, [number, number]> = {
  reply_budget: [1, 50],
  max_handoffs: [0, 10],
  daily_cap: [1, 500],
};

export class Settings {
  constructor(private db: Db) {}

  get(): Limits {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const v = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
    return { reply_budget: v.reply_budget, max_handoffs: v.max_handoffs, daily_cap: v.daily_cap } as Limits;
  }

  /** Changes one or more limits. Every value is checked before anything is saved. */
  update(patch: Partial<Limits>): Limits {
    const entries = Object.entries(patch);
    for (const [key, value] of entries) {
      const bounds = BOUNDS[key as keyof Limits];
      if (!bounds) throw new SettingsError(`Unknown setting ${key}.`);
      if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds[0] || value > bounds[1]) {
        throw new SettingsError(`${key} must be a whole number from ${bounds[0]} to ${bounds[1]}.`);
      }
    }
    for (const [key, value] of entries) this.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), key);
    return this.get();
  }
}
