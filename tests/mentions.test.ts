import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseMentions } from '../src/mentions.js';

const names = ['Owner', 'Muse', 'Grokbot', 'Dots', 'Duet'];

describe('parseMentions', () => {
  it('finds known names once each, ignoring case, plus @everyone', () => {
    expect(parseMentions('@Muse and @muse, then @DOTS. @everyone!', names)).toEqual(['muse', 'dots', 'everyone']);
  });
  it('ignores unknown names, emails and names glued to longer words', () => {
    expect(parseMentions('@Nobody mail me at t@muse.example or @Musebot', names)).toEqual([]);
  });
  it('finishes adversarial text quickly (child process with a 5 s timeout)', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/regex-adversarial.ts'], { timeout: 5_000, encoding: 'utf8' });
    expect(r.signal).toBeNull();
    expect(r.stdout.trim()).toBe('ok');
  });
});
