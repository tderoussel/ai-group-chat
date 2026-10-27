import { describe, expect, it } from 'vitest';
import { hashSecret, newSecret, sameHash, sameSecret } from '../src/keys.js';

describe('keys', () => {
  it('makes 32-byte base64url secrets that differ every time', () => {
    const a = newSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSecret()).not.toBe(a);
  });
  it('hashes with SHA-256 hex', () => {
    expect(hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('compares secrets and hashes', () => {
    expect(sameSecret('one', 'one')).toBe(true);
    expect(sameSecret('one', 'two')).toBe(false);
    expect(sameHash(hashSecret('a'), hashSecret('a'))).toBe(true);
    expect(sameHash(hashSecret('a'), hashSecret('b'))).toBe(false);
    expect(sameHash('abcd', hashSecret('a'))).toBe(false);
    expect(sameHash('zz', 'yy')).toBe(false);
    expect(sameHash('', '')).toBe(false);
    expect(sameHash('ab', 'abc')).toBe(false);
    expect(sameHash(hashSecret('a'), hashSecret('a') + 'zz')).toBe(false);
  });
});
