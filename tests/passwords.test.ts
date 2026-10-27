import { describe, expect, it } from 'vitest';
import { checkPassword, decoyCheck, hashPassword, MAX_PASSWORD, passwordProblem } from '../src/passwords.js';

describe('passwords', () => {
  it('hashes with a fresh salt each time and accepts only the right password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(await checkPassword('correct horse battery', a)).toBe(true);
    expect(await checkPassword('correct horse batterY', a)).toBe(false);
  });
  it('says no, never throws, for malformed stored values or other settings', async () => {
    const good = await hashPassword('correct horse battery');
    const parts = good.split('$');
    const bad = ['', 'plain', good.replace('scrypt', 'bcrypt'), ['scrypt', '1048576', ...parts.slice(2)].join('$'), parts.slice(0, 5).join('$'), `${good}$extra`, `${good}\0`, `${good} `];
    for (const stored of bad) expect(await checkPassword('correct horse battery', stored)).toBe(false);
  });
  it('fails a password longer than the limit, even one that starts with the right password', async () => {
    const password = 'p'.repeat(MAX_PASSWORD);
    const stored = await hashPassword(password);
    expect(await checkPassword(password, stored)).toBe(true);
    expect(await checkPassword(`${password}x`, stored)).toBe(false);
  });
  it('explains new passwords that are too short or too long', () => {
    expect(passwordProblem('short')).toMatch(/at least 12/);
    expect(passwordProblem('x'.repeat(201))).toMatch(/at most 200/);
    expect(passwordProblem('twelve chars')).toBeNull();
  });
  it('runs the decoy check without a stored hash', async () => {
    await expect(decoyCheck('anything at all')).resolves.toBeUndefined();
  });
});
