import type { Clock } from './clock.js';
import type { Db } from './db.js';
import { hashSecret, newSecret } from './keys.js';

export const SESSION_COOKIE = 'gc_session';
const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;

export class Sessions {
  constructor(private db: Db, private clock: Clock) {}

  /** Starts a session for a member (the owner or a person) and returns its token. Only the token's hash is stored. */
  create(memberId: number): string {
    const token = newSecret();
    const expires = new Date(this.clock().getTime() + SESSION_DAYS * DAY_MS).toISOString();
    this.db.prepare('INSERT INTO sessions (id_hash, expires_at, member_id) VALUES (?, ?, ?)').run(hashSecret(token), expires, memberId);
    return token;
  }

  /** The member a live session belongs to, or null. It counts only while that member is the owner or a person who wasn't removed. */
  memberId(token: string | undefined): number | null {
    if (!token) return null;
    const row = this.db.prepare(`SELECT s.member_id AS id FROM sessions s JOIN members m ON m.id = s.member_id
      WHERE s.id_hash = ? AND s.expires_at > ? AND m.kind != 'agent' AND m.revoked_at IS NULL`)
      .get(hashSecret(token), this.clock().toISOString()) as { id: number } | undefined;
    return row ? Number(row.id) : null;
  }

  remove(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashSecret(token));
  }

  /** Signs a member out everywhere. */
  removeAllFor(memberId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE member_id = ?').run(memberId);
  }
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86_400}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
