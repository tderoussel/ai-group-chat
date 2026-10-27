import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 200;

// scrypt settings. checkPassword accepts only these, so a stored value can never ask for more work.
const N = 32_768;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_MEMORY = 64 * 1024 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** The hash of a password nobody uses, so a check for a name that doesn't exist costs one real hash, every time. */
const DECOY_HASH = 'scrypt$32768$8$1$qs8gfs-VTppjygjvwPhu-Q$oEYb8zixkbH7e6MhiyeKA_8MwdY8WzCYf6QXf3l5vEU';

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEMORY }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Why a new password can't be used, or null when it can. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `Passwords are at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Passwords are at most ${MAX_PASSWORD} characters.`;
  return null;
}

/** "scrypt$N$r$p$salt$hash", with the salt and hash in base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Whether the password matches a stored hash, compared in constant time. A malformed stored value is a no, never an error. */
export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== String(N) || parts[2] !== String(R) || parts[3] !== String(P)) return false;
  if (!BASE64URL.test(parts[4] as string) || !BASE64URL.test(parts[5] as string)) return false;
  const salt = Buffer.from(parts[4] as string, 'base64url');
  const expected = Buffer.from(parts[5] as string, 'base64url');
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
  // A too-long password still costs one hash, so its length isn't a shortcut, then fails.
  const key = await derive(password.slice(0, MAX_PASSWORD), salt);
  return password.length <= MAX_PASSWORD && timingSafeEqual(key, expected);
}

/** Spends the same work as checkPassword without a real hash, so a wrong name takes as long as a wrong password. */
export async function decoyCheck(password: string): Promise<void> {
  await checkPassword(password, DECOY_HASH);
}
