import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes as base64url (43 characters). Used for agent keys, invite tokens and session tokens. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison of two secrets (compares their hashes, so lengths never leak). */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hashSecret(a), 'hex'), Buffer.from(hashSecret(b), 'hex'));
}

const HEX = /^(?:[0-9a-f]{2})+$/i;

/** Constant-time comparison of two hex hashes. */
export function sameHash(hexA: string, hexB: string): boolean {
  if (!HEX.test(hexA) || !HEX.test(hexB)) return false;
  const a = Buffer.from(hexA, 'hex');
  const b = Buffer.from(hexB, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
