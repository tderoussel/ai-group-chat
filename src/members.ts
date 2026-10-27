import type { Clock } from './clock.js';
import type { Db } from './db.js';
import { hashSecret, newSecret } from './keys.js';
import { checkPassword, decoyCheck, hashPassword, passwordProblem } from './passwords.js';

/** 'owner' set the chat up; 'person' is someone the owner or another person added; agents are never people. */
export type MemberKind = 'owner' | 'person' | 'agent';

export type Member = {
  id: number;
  name: string;
  kind: MemberKind;
  lastCheckInAt: string | null;
  revoked: boolean;
  readPosition: number;
  /** The owner always; a person once they have picked a password; never an agent. */
  joined: boolean;
  /** People only: when their current invite link stops working, or null when they have none. */
  inviteExpiresAt: string | null;
};

export class MemberError extends Error {}

export const INVITE_DAYS = 7;
export const INVITE_GONE = 'This invite link has expired or was already used. Ask for a new one.';
/** The longest name a member can have. */
export const MAX_NAME = 24;
const NAME = new RegExp(`^[A-Za-z0-9_]{1,${MAX_NAME}}$`);
const RESERVED = new Set(['everyone']);
const DAY_MS = 86_400_000;

/** Whether agents take this member's instructions and the member may use the page: the owner, or a person who wasn't removed. */
export function isOwner(m: Member): boolean {
  return m.kind !== 'agent' && !m.revoked;
}

export class Members {
  constructor(private db: Db, private clock: Clock) {}

  /** Adds an agent. The key is returned once and only its hash is stored. */
  createAgent(name: string): { member: Member; key: string } {
    this.checkNewName(name);
    const key = newSecret();
    const r = this.db.prepare(`INSERT INTO members (name, kind, key_hash, key_created_at) VALUES (?, 'agent', ?, ?)`)
      .run(name, hashSecret(key), this.clock().toISOString());
    return { member: this.byId(Number(r.lastInsertRowid)) as Member, key };
  }

  /** Gives an agent a new key. This also brings back a revoked agent. */
  rotateKey(id: number): string {
    this.agentOrThrow(id);
    const key = newSecret();
    this.db.prepare('UPDATE members SET key_hash = ?, key_created_at = ?, revoked_at = NULL WHERE id = ?')
      .run(hashSecret(key), this.clock().toISOString(), id);
    return key;
  }

  /** Cuts an agent off: its key stops working on the next call. */
  revoke(id: number): void {
    this.agentOrThrow(id);
    this.db.prepare('UPDATE members SET key_hash = NULL, revoked_at = ? WHERE id = ?').run(this.clock().toISOString(), id);
  }

  /** The active agent that owns this key. Looks up the key's SHA-256, so timing reveals nothing about stored keys. */
  agentByKey(key: string): Member | null {
    const row = this.db.prepare(`SELECT * FROM members WHERE key_hash = ? AND kind = 'agent' AND revoked_at IS NULL`).get(hashSecret(key));
    return row ? toMember(row) : null;
  }

  /** Adds a person. Their invite token is returned once; only its hash is stored, and it works once within INVITE_DAYS. */
  createPerson(name: string): { member: Member; token: string } {
    this.checkNewName(name);
    const token = newSecret();
    const r = this.db.prepare(`INSERT INTO members (name, kind, invite_hash, invite_expires_at) VALUES (?, 'person', ?, ?)`)
      .run(name, hashSecret(token), this.inviteExpiry());
    return { member: this.byId(Number(r.lastInsertRowid)) as Member, token };
  }

  /** A new invite token for a person; their previous link stops working. Their password and sessions stay until they use it. */
  newInvite(id: number): string {
    this.personOrThrow(id);
    const token = newSecret();
    this.db.prepare('UPDATE members SET invite_hash = ?, invite_expires_at = ? WHERE id = ?').run(hashSecret(token), this.inviteExpiry(), id);
    return token;
  }

  /** The person an unexpired invite token belongs to, or null. */
  personByInvite(token: string): Member | null {
    const row = this.db.prepare(`SELECT * FROM members WHERE invite_hash = ? AND kind = 'person' AND invite_expires_at > ?`)
      .get(hashSecret(token), this.clock().toISOString());
    return row ? toMember(row) : null;
  }

  /**
   * Uses an invite: sets the person's password, clears the link and brings them back if they were removed. `joining` is
   * false when a person who had joined is only picking a new password. The link is claimed in one statement after the
   * hashing, so it works once even when two tries race.
   */
  async acceptInvite(token: string, password: string): Promise<{ member: Member; joining: boolean }> {
    const person = this.personByInvite(token);
    if (!person) throw new MemberError(INVITE_GONE);
    const problem = passwordProblem(password);
    if (problem) throw new MemberError(problem);
    const hash = await hashPassword(password);
    const claimed = this.db.prepare(`UPDATE members SET password_hash = ?, invite_hash = NULL, invite_expires_at = NULL, revoked_at = NULL
      WHERE id = ? AND invite_hash = ? AND invite_expires_at > ?`).run(hash, person.id, hashSecret(token), this.clock().toISOString());
    if (Number(claimed.changes) !== 1) throw new MemberError(INVITE_GONE);
    return { member: this.byId(person.id) as Member, joining: !person.joined };
  }

  /** The joined, active person with this name and password, or null. A name with no such person costs the same hashing. */
  async personByPassword(name: string, password: string): Promise<Member | null> {
    const row = this.db.prepare(`SELECT * FROM members WHERE name = ? COLLATE NOCASE AND kind = 'person'
      AND revoked_at IS NULL AND password_hash IS NOT NULL`).get(name);
    if (!row) {
      await decoyCheck(password);
      return null;
    }
    return (await checkPassword(password, String(row.password_hash))) ? toMember(row) : null;
  }

  /** Removes a person: their password and invite link stop working. The owner can't be removed, and nobody removes themselves. */
  removePerson(id: number, by: Member): Member {
    const person = this.personOrThrow(id);
    if (person.id === by.id) throw new MemberError("You can't remove yourself.");
    if (person.revoked) throw new MemberError(`${person.name} was already removed.`);
    this.db.prepare('UPDATE members SET revoked_at = ?, password_hash = NULL, invite_hash = NULL, invite_expires_at = NULL WHERE id = ?')
      .run(this.clock().toISOString(), id);
    return this.byId(id) as Member;
  }

  /** The names of the people whose instructions agents take: the owner and every joined person who wasn't removed. */
  ownerNames(): string[] {
    return (this.db.prepare(`SELECT name FROM members WHERE revoked_at IS NULL AND (kind = 'owner' OR (kind = 'person' AND password_hash IS NOT NULL))
      ORDER BY id`).all() as { name: string }[]).map((r) => r.name);
  }

  byId(id: number): Member | null {
    const row = this.db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    return row ? toMember(row) : null;
  }

  byName(name: string): Member | null {
    const row = this.db.prepare('SELECT * FROM members WHERE name = ? COLLATE NOCASE').get(name);
    return row ? toMember(row) : null;
  }

  list(): Member[] {
    return this.db.prepare('SELECT * FROM members ORDER BY id').all().map((row) => toMember(row));
  }

  /** The person who set the chat up: member 1. */
  owner(): Member {
    return this.byId(1) as Member;
  }

  /** Gives the owner the name from OWNER_NAME. Message authors are joined by id, so old messages show the new name. */
  renameOwner(name: string): void {
    this.checkNameRules(name);
    const taken = this.byName(name);
    if (taken && taken.id !== 1) throw new MemberError(`"${name}" is already the name of another member.`);
    this.db.prepare('UPDATE members SET name = ? WHERE id = 1').run(name);
  }

  private checkNameRules(name: string): void {
    if (!NAME.test(name)) throw new MemberError(`Names are 1 to ${MAX_NAME} letters, digits or underscores.`);
    if (RESERVED.has(name.toLowerCase())) throw new MemberError(`"${name}" is reserved.`);
  }

  private checkNewName(name: string): void {
    this.checkNameRules(name);
    if (this.byName(name)) throw new MemberError(`There is already a member called ${name}.`);
  }

  private inviteExpiry(): string {
    return new Date(this.clock().getTime() + INVITE_DAYS * DAY_MS).toISOString();
  }

  private agentOrThrow(id: number): Member {
    const m = this.byId(id);
    if (!m || m.kind !== 'agent') throw new MemberError('There is no such agent.');
    return m;
  }

  private personOrThrow(id: number): Member {
    const m = this.byId(id);
    if (!m || m.kind !== 'person') throw new MemberError('There is no such person.');
    return m;
  }
}

function toMember(row: Record<string, unknown>): Member {
  const kind: MemberKind = row.kind === 'owner' ? 'owner' : row.kind === 'person' ? 'person' : 'agent';
  return {
    id: Number(row.id),
    name: String(row.name),
    kind,
    lastCheckInAt: row.last_check_in_at == null ? null : String(row.last_check_in_at),
    revoked: row.revoked_at != null,
    readPosition: Number(row.read_position),
    joined: kind === 'owner' || (kind === 'person' && row.password_hash != null),
    inviteExpiresAt: row.invite_expires_at == null ? null : String(row.invite_expires_at),
  };
}
