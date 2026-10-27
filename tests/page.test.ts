import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../public/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');
/** The files in public/, leaving out dotfiles such as macOS's .DS_Store. */
const files = readdirSync(dir).filter((name) => !name.startsWith('.'));
const scripts = files.filter((f) => f.endsWith('.js'));
/** The page scripts the server serves (src/web.ts STATIC). A module outside this list would answer 404. */
const SERVED = ['api.js', 'app.js', 'lib.js', 'login.js', 'people.js', 'thread.js', 'updates.js'];

describe('page contract', () => {
  it('the scripts in public/ are exactly the ones the import check treats as served, so every served script is checked', () => {
    expect([...scripts].sort()).toEqual([...SERVED].sort());
  });
  it('src/web.ts maps exactly the files in public/ and nothing outside that folder', () => {
    const web = readFileSync(new URL('../src/web.ts', import.meta.url), 'utf8');
    const mapped = [...web.matchAll(/pub\('([^']+)'\)/g)].map((m) => m[1]).sort();
    expect(mapped).toEqual([...files].sort());
    expect(web).not.toMatch(/node_modules/);
  });
  it('every element a script looks up by id exists in index.html', () => {
    const ids = new Set([...read('index.html').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const missing = scripts.flatMap((file) =>
      [...read(file).matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]!).filter((id) => !ids.has(id)).map((id) => `${file}: #${id}`));
    expect(missing).toEqual([]);
  });
  it('every name a page script imports is exported by a file the server serves', () => {
    const problems: string[] = [];
    for (const file of scripts) {
      for (const m of read(file).matchAll(/import \{([^}]+)\} from '\.\/([\w-]+\.js)'/g)) {
        const source = m[2]!;
        if (!SERVED.includes(source)) { problems.push(`${file} imports ${source}, which the server doesn't serve`); continue; }
        const text = read(source);
        for (const name of m[1]!.split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!new RegExp(`export (async )?(function|const|let) ${name}\\b`).test(text)) problems.push(`${file} imports ${name} from ${source}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
  it('index.html loads only app files, and has no inline style for the CSP to block', () => {
    const html = read('index.html');
    expect([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])).toEqual(['/style.css', '/app.js']);
    expect(html).not.toMatch(/\sstyle=|<style/);
  });
  it('no page script writes HTML: messages and names are untrusted text', () => {
    const banned = /innerHTML|outerHTML|insertAdjacentHTML|document\.write/;
    expect(scripts.filter((file) => banned.test(read(file)))).toEqual([]);
  });
  it('index.html has every id the page needs, including ones passed to helpers like copyButton', () => {
    const ids = new Set([...read('index.html').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const required = ['page-error', 'login', 'setup-form', 'setup-code', 'login-error', 'login-name', 'chat', 'app-name',
      'agent-summary', 'avatar-stack', 'open-agents', 'thread', 'chat-error', 'composer', 'message', 'agents', 'close-agents',
      'budget', 'member-list', 'join-card', 'join-title', 'join-card-text', 'copy-card', 'copy-key', 'close-card',
      'add-agent', 'agent-name', 'sign-out', 'login-user', 'invite', 'invite-form', 'invite-heading', 'invite-welcome',
      'invite-user', 'invite-password', 'invite-again', 'invite-error', 'people-list', 'invite-panel', 'invite-title',
      'invite-link-text', 'copy-invite', 'close-invite', 'add-person', 'person-name'];
    expect(required.filter((id) => !ids.has(id))).toEqual([]);
  });
});
