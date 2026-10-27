import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Members } from '../src/members.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
/** The settings the app reads from its environment, so a developer's own values can't change what this test sees. */
const APP_SETTINGS = ['APP_NAME', 'APP_ORIGIN', 'DATA_DIR', 'DATA_KEY', 'OWNER_NAME', 'PORT', 'RENDER_EXTERNAL_URL', 'SETUP_CODE', 'TIME_ZONE'];
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !APP_SETTINGS.includes(name)));

describe('boot', () => {
  it('refuses to start, and says why, when OWNER_NAME is already the name of another member', () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-chat-boot-'));
    try {
      const db = openDb(dir);
      new Members(db, () => new Date()).createAgent('Muse');
      db.close();
      // Runs src/main.ts the way `npm start` does. If the boot did not refuse, this would be a running server:
      // the timeout then kills it and the test fails, so nothing is left running either way.
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'], {
        cwd: repo,
        timeout: 20_000,
        encoding: 'utf8',
        env: { ...inheritedEnv, OWNER_NAME: 'muse', APP_ORIGIN: 'http://localhost:3999', SETUP_CODE: 'a-setup-code-for-this-test', DATA_DIR: dir, PORT: '3999' },
      });
      expect(r.error, 'the process should exit on its own, not be killed by the timeout').toBeUndefined();
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain('config: OWNER_NAME: "muse" is already the name of another member.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
