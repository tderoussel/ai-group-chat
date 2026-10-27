import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTestAgent } from '../scripts/test-agent.js';
import { Chat } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { Members } from '../src/members.js';
import { RateLimiter } from '../src/ratelimit.js';
import { Sessions } from '../src/sessions.js';
import { Settings } from '../src/settings.js';
import { createApp } from '../src/web.js';

const CODE = 'setup-code-0123456789-abcdef';
let server: Server;
let base: string;

beforeEach(async () => {
  const db = openDb(':memory:');
  const clock = () => new Date();
  const members = new Members(db, clock);
  const settings = new Settings(db);
  server = createServer(createApp({
    config: loadConfig({ APP_ORIGIN: 'http://localhost:3000', SETUP_CODE: CODE }),
    members, settings, chat: new Chat(db, members, settings, clock), sessions: new Sessions(db, clock),
    doorLimiter: new RateLimiter(60, 60_000), loginLimiter: new RateLimiter(10, 60_000), nameLimiter: new RateLimiter(20, 3_600_000), version: 'test', log: () => {},
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise((resolve) => server.close(resolve)); });

const post = (path: string, body: unknown, cookie?: string) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-group-chat': '1', ...(cookie ? { cookie: `gc_session=${cookie}` } : {}) },
  body: JSON.stringify(body),
});

describe('end to end', () => {
  it('serves the page and its scripts with the security policy', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('<script type="module" src="/app.js"></script>');
    for (const file of ['/app.js', '/api.js', '/lib.js', '/login.js', '/thread.js', '/people.js', '/updates.js', '/style.css']) {
      expect((await fetch(base + file)).status, file).toBe(200);
    }
  });
  it('the owner posts, the test agent reads it through the door and replies, and the owner sees the reply', async () => {
    const login = await post('/api/setup-login', { code: CODE });
    const cookie = (/gc_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '') as RegExpExecArray)[1] as string;
    const card = (await (await post('/api/agents', { name: 'Tester' }, cookie)).json()).joinCard as string;
    const key = (/\/mcp\/([A-Za-z0-9_-]{43})/.exec(card) as RegExpExecArray)[1] as string;
    await post('/api/messages', { text: 'Hello @Tester' }, cookie);
    const out = await runTestAgent(`${base}/mcp/${key}`, 'Hello from the test agent');
    expect(out.tools).toEqual(['post_message', 'read_new_messages', 'request_approval']);
    expect(out.read).toMatchObject({ you_were_mentioned: true, messages: [expect.objectContaining({ text: 'Hello @Tester' })] });
    expect(out.posted).toMatchObject({ handoff_depth: 0 });
    const thread = await (await fetch(`${base}/api/messages`, { headers: { cookie: `gc_session=${cookie}` } })).json();
    expect(thread.messages.map((m: { from: string; text: string }) => `${m.from}: ${m.text}`)).toEqual(['Owner: Hello @Tester', 'Tester: Hello from the test agent']);
  });
});
