import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export const DEFAULT_SETTINGS = { reply_budget: 8, max_handoffs: 3, daily_cap: 60 } as const;

/** The schema version openDb brings every database to (PRAGMA user_version). */
export const DB_VERSION = 1;

/** SCHEMA_V0 is the first version. Once a database exists, never edit it: add a migration instead. */
export const SCHEMA_V0 = `
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'agent')),
  key_hash TEXT UNIQUE,
  key_created_at TEXT,
  revoked_at TEXT,
  last_check_in_at TEXT,
  read_position INTEGER NOT NULL DEFAULT 0,
  wake_url TEXT,
  wake_key_sealed TEXT,
  last_wake_at TEXT,
  last_wake_status TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'request', 'system')),
  text TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  reply_to INTEGER REFERENCES messages(id),
  handoff_depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_day ON messages (day);
CREATE TABLE IF NOT EXISTS requests (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id),
  action TEXT NOT NULL,
  asked_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  refresh_before TEXT
);
`;

/**
 * Version 1, people. Members may be people the owner adds, with a password and an invite link; sessions belong to a
 * member; a request card remembers who decided it. SQLite can't change a CHECK, so members is rebuilt in SQLite's
 * documented order (create the new table, copy, drop the old one, rename). Rows that existed before become the
 * owner's: the owner's sessions, and the cards only the owner could decide.
 */
const TO_VERSION_1 = `
CREATE TABLE members_v1 (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'person', 'agent')),
  key_hash TEXT UNIQUE,
  key_created_at TEXT,
  revoked_at TEXT,
  last_check_in_at TEXT,
  read_position INTEGER NOT NULL DEFAULT 0,
  wake_url TEXT,
  wake_key_sealed TEXT,
  last_wake_at TEXT,
  last_wake_status TEXT,
  password_hash TEXT,
  invite_hash TEXT UNIQUE,
  invite_expires_at TEXT
);
INSERT INTO members_v1 (id, name, kind, key_hash, key_created_at, revoked_at, last_check_in_at, read_position,
  wake_url, wake_key_sealed, last_wake_at, last_wake_status)
  SELECT id, name, kind, key_hash, key_created_at, revoked_at, last_check_in_at, read_position,
  wake_url, wake_key_sealed, last_wake_at, last_wake_status FROM members;
DROP TABLE members;
ALTER TABLE members_v1 RENAME TO members;
ALTER TABLE sessions ADD COLUMN member_id INTEGER NOT NULL DEFAULT 1 REFERENCES members(id);
ALTER TABLE requests ADD COLUMN decided_by INTEGER REFERENCES members(id);
UPDATE requests SET decided_by = 1 WHERE status != 'pending';
`;

/** Each migration's SQL, in order: MIGRATIONS[i] takes a database from version i to i + 1. */
const MIGRATIONS = [TO_VERSION_1];

/**
 * Opens the chat database, creating the folder, schema and seed rows if needed, and migrating it to DB_VERSION.
 * Before migrating a database that already held data, it copies it beside itself. Pass ':memory:' in tests.
 */
export function openDb(dataDirOrMemory: string, log: (line: string) => void = () => {}): Db {
  let path = ':memory:';
  if (dataDirOrMemory !== ':memory:') {
    mkdirSync(dataDirOrMemory, { recursive: true });
    path = join(dataDirOrMemory, 'chat.db');
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const hadData = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'members'`).get() !== undefined;
  db.exec(SCHEMA_V0);
  try {
    migrate(db, hadData && path !== ':memory:' ? dataDirOrMemory : null, log);
  } catch (e) {
    db.close();
    throw e;
  }
  db.prepare(`INSERT OR IGNORE INTO members (id, name, kind) VALUES (1, 'Owner', 'owner')`).run();
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  }
  return db;
}

/**
 * Runs the migrations this database hasn't had, each in its own transaction with foreign keys off (SQLite ignores that
 * switch inside a transaction). A migration that leaves a broken reference rolls back and stops the server starting.
 */
function migrate(db: Db, backupDir: string | null, log: (line: string) => void): void {
  const version = userVersion(db);
  if (version >= MIGRATIONS.length) return;
  let backup: string | null = null;
  if (backupDir) {
    backup = join(backupDir, `chat-before-v${version + 1}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    log(`database: copied to ${backup} before migrating`);
  }
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    for (let v = version; v < MIGRATIONS.length; v += 1) {
      tx(db, () => {
        db.exec(MIGRATIONS[v] as string);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length > 0) throw new Error(`database: migration to version ${v + 1} left ${broken.length} broken references`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
      log(`database: migrated to version ${v + 1}`);
    }
  } catch (e) {
    // Nothing changed when no migration finished, so the copy is redundant. Removing it stops a crash loop filling the disk.
    if (backup && userVersion(db) === version) rmSync(backup, { force: true });
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

function userVersion(db: Db): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

/** Runs fn inside one transaction; rolls back if it throws. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
