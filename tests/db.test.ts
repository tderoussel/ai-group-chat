import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_VERSION, openDb, SCHEMA_V0, tx } from '../src/db.js';
import { hashSecret } from '../src/keys.js';
import { Sessions } from '../src/sessions.js';

const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const version = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
const backupsIn = (dir: string) => readdirSync(dir).filter((f) => /^chat-before-v1-.+\.db$/.test(f));

/** Every temp folder a test makes, removed after that test, so a run leaves nothing behind. */
const made: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'group-chat-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A version-0 database: the owner, an agent, a cut-off agent with a wake link, a decided and a pending card, an events subscription, a session. */
function versionZero(): string {
  const dir = tempDir();
  const raw = new DatabaseSync(join(dir, 'chat.db'));
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  raw.exec(SCHEMA_V0);
  raw.exec(`
    INSERT INTO members (id, name, kind) VALUES (1, 'Owner', 'owner');
    INSERT INTO members (id, name, kind, key_hash, key_created_at, last_check_in_at, read_position) VALUES (2, 'Muse', 'agent', 'aa', '2026-10-24T00:00:00.000Z', '2026-10-25T10:00:00.000Z', 3);
    INSERT INTO members (id, name, kind, revoked_at, wake_url, wake_key_sealed, last_wake_status) VALUES (3, 'Grokbot', 'agent', '2026-10-25T11:00:00.000Z', 'https://example.com/hook', 'sealed', 'woken');
    INSERT INTO messages (id, author_id, kind, text, created_at, day) VALUES (1, 1, 'message', 'Hi', '2026-10-25T10:00:00.000Z', '2026-10-25');
    INSERT INTO messages (id, author_id, kind, text, created_at, day) VALUES (2, 2, 'request', 'Request: post it', '2026-10-25T10:01:00.000Z', '2026-10-25');
    INSERT INTO messages (id, author_id, kind, text, created_at, day) VALUES (3, 2, 'request', 'Request: buy it', '2026-10-25T10:02:00.000Z', '2026-10-25');
    INSERT INTO messages (id, author_id, kind, text, reply_to, created_at, day) VALUES (4, 1, 'system', 'Owner approved request #2: post it', 2, '2026-10-25T10:03:00.000Z', '2026-10-25');
    INSERT INTO requests (message_id, action, status, decided_at) VALUES (2, 'post it', 'approved', '2026-10-25T10:03:00.000Z');
    INSERT INTO requests (message_id, action) VALUES (3, 'buy it');
    INSERT INTO event_subscriptions (id, member_id, name, url, secret_sealed, created_at) VALUES ('sub_1', 2, 'chat.tagged', 'https://example.com/cb', 'sealed', '2026-10-25T10:00:00.000Z');
    INSERT INTO sessions (id_hash, expires_at) VALUES ('${hashSecret('old-session')}', '2099-01-01T00:00:00.000Z');
    INSERT INTO settings (key, value) VALUES ('reply_budget', '5');
  `);
  raw.close();
  return dir;
}

describe('openDb', () => {
  it('creates every table at the current version, with the owner and the default limits', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    // Exactly these, so a table nothing uses can't linger: SQLite's own sqlite_sequence is not ours.
    expect(tables.filter((name) => !name.startsWith('sqlite_')).sort()).toEqual(['event_subscriptions', 'members', 'messages', 'requests', 'sessions', 'settings']);
    expect(tables).not.toContain('members_v1');
    expect(version(db)).toBe(DB_VERSION);
    expect(columns(db, 'members')).toEqual(expect.arrayContaining(['wake_url', 'wake_key_sealed', 'last_wake_at', 'last_wake_status', 'password_hash', 'invite_hash', 'invite_expires_at']));
    expect(columns(db, 'sessions')).toEqual(['id_hash', 'expires_at', 'member_id']);
    expect(columns(db, 'requests')).toContain('decided_by');
    expect(db.prepare('SELECT id, name, kind FROM members').all()).toEqual([{ id: 1, name: 'Owner', kind: 'owner' }]);
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({ reply_budget: '8', max_handoffs: '3', daily_cap: '60' });
  });
  it("keeps each message's calendar day in a column named day, with an index on it", () => {
    const db = openDb(':memory:');
    expect(columns(db, 'messages')).toEqual(['id', 'author_id', 'kind', 'text', 'mentions', 'reply_to', 'handoff_depth', 'created_at', 'day']);
    const indexes = (db.prepare('PRAGMA index_list(messages)').all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toEqual(['messages_day']);
    const indexed = (db.prepare('PRAGMA index_info(messages_day)').all() as { name: string }[]).map((c) => c.name);
    expect(indexed).toEqual(['day']);
  });
  it('keeps data on disk across reopenings without duplicating the seed rows, and copies nothing for a new database', () => {
    const dir = tempDir();
    const a = openDb(dir);
    a.prepare(`INSERT INTO settings (key, value) VALUES ('x', '1')`).run();
    a.close();
    const b = openDb(dir);
    expect(b.prepare(`SELECT value FROM settings WHERE key = 'x'`).get()).toEqual({ value: '1' });
    expect((b.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n).toBe(1);
    b.close();
    expect(backupsIn(dir)).toEqual([]);
  });
  it('migrates a version-0 database to version 1, keeping every row, after copying it', () => {
    const dir = versionZero();
    const logs: string[] = [];
    const db = openDb(dir, (line) => logs.push(line));
    expect(version(db)).toBe(1);
    expect(db.prepare('SELECT id, name, kind, key_hash, read_position, revoked_at, wake_url, last_wake_status, password_hash FROM members ORDER BY id').all()).toEqual([
      { id: 1, name: 'Owner', kind: 'owner', key_hash: null, read_position: 0, revoked_at: null, wake_url: null, last_wake_status: null, password_hash: null },
      { id: 2, name: 'Muse', kind: 'agent', key_hash: 'aa', read_position: 3, revoked_at: null, wake_url: null, last_wake_status: null, password_hash: null },
      { id: 3, name: 'Grokbot', kind: 'agent', key_hash: null, read_position: 0, revoked_at: '2026-10-25T11:00:00.000Z', wake_url: 'https://example.com/hook', last_wake_status: 'woken', password_hash: null },
    ]);
    expect(db.prepare('SELECT id, author_id, kind, reply_to FROM messages ORDER BY id').all()).toEqual([
      { id: 1, author_id: 1, kind: 'message', reply_to: null }, { id: 2, author_id: 2, kind: 'request', reply_to: null },
      { id: 3, author_id: 2, kind: 'request', reply_to: null }, { id: 4, author_id: 1, kind: 'system', reply_to: 2 },
    ]);
    expect(db.prepare('SELECT message_id, status, decided_by FROM requests ORDER BY message_id').all()).toEqual([
      { message_id: 2, status: 'approved', decided_by: 1 }, { message_id: 3, status: 'pending', decided_by: null },
    ]);
    expect(db.prepare('SELECT id, member_id FROM event_subscriptions').all()).toEqual([{ id: 'sub_1', member_id: 2 }]);
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'reply_budget'`).get()).toEqual({ value: '5' });
    expect(new Sessions(db, () => new Date('2026-10-25T12:00:00Z')).memberId('old-session')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The new kind is allowed, an unknown one isn't, and foreign keys are checked again.
    db.prepare(`INSERT INTO members (name, kind) VALUES ('Sarah', 'person')`).run();
    expect(() => db.prepare(`INSERT INTO members (name, kind) VALUES ('Robo', 'robot')`).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO messages (author_id, kind, text, created_at, day) VALUES (99, 'message', 'x', 'x', 'x')`).run()).toThrow(/FOREIGN KEY/);
    // The copy is the version-0 database, whole.
    const [backup] = backupsIn(dir);
    expect(backup).toBeDefined();
    const copy = new DatabaseSync(join(dir, backup as string));
    expect(version(copy)).toBe(0);
    expect(copy.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 4 });
    copy.close();
    expect(logs).toEqual([expect.stringMatching(/^database: copied to .+chat-before-v1-.+\.db before migrating$/), 'database: migrated to version 1']);
    db.close();
    // Opening it again neither migrates nor copies again.
    openDb(dir, (line) => logs.push(line)).close();
    expect(logs).toHaveLength(2);
    expect(backupsIn(dir)).toHaveLength(1);
  });
  it('rolls the whole migration back, and refuses to open, when it would leave a broken reference', () => {
    const dir = versionZero();
    const raw = new DatabaseSync(join(dir, 'chat.db'));
    raw.exec(`PRAGMA foreign_keys = OFF; INSERT INTO messages (author_id, kind, text, created_at, day) VALUES (42, 'message', 'orphan', 'x', 'x');`);
    raw.close();
    expect(() => openDb(dir)).toThrow(/broken references/);
    expect(() => openDb(dir)).toThrow(/broken references/);
    // Nothing changed, so no copy is kept: a server failing to start again and again can't fill the disk.
    expect(backupsIn(dir)).toEqual([]);
    const after = new DatabaseSync(join(dir, 'chat.db'));
    expect(version(after)).toBe(0);
    expect(columns(after, 'sessions')).toEqual(['id_hash', 'expires_at']);
    expect(after.prepare(`SELECT sql FROM sqlite_master WHERE name = 'members'`).get()).toEqual({ sql: expect.stringContaining("kind IN ('owner', 'agent')") });
    expect(after.prepare(`SELECT name FROM sqlite_master WHERE name = 'members_v1'`).get()).toBeUndefined();
    after.close();
  });
  it('tx rolls back when the callback throws', () => {
    const db = openDb(':memory:');
    expect(() => tx(db, () => {
      db.prepare(`INSERT INTO settings (key, value) VALUES ('y', '2')`).run();
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'y'`).get()).toBeUndefined();
  });
});
