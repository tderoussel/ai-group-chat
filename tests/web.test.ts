import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Chat } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { INVITE_GONE, Members } from '../src/members.js';
import { headersReached, heldPost } from './fixtures/held-post.js';
import { RateLimiter } from '../src/ratelimit.js';
import { Sessions } from '../src/sessions.js';
import { Settings } from '../src/settings.js';
import { type AppDeps, createApp } from '../src/web.js';

const CODE = 'setup-code-0123456789-abcdef';
let server: Server;
let base: string;
let deps: AppDeps;
let logs: string[];

beforeEach(async () => {
  const db = openDb(':memory:');
  const clock = () => new Date();
  const members = new Members(db, clock);
  const settings = new Settings(db);
  logs = [];
  deps = {
    config: loadConfig({ APP_ORIGIN: 'http://localhost:3000', SETUP_CODE: CODE }),
    members, settings, chat: new Chat(db, members, settings, clock), sessions: new Sessions(db, clock),
    doorLimiter: new RateLimiter(60, 60_000), loginLimiter: new RateLimiter(10, 60_000), nameLimiter: new RateLimiter(20, 3_600_000),
    version: 'test', log: (line) => logs.push(line),
  };
  server = createServer(createApp(deps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise((resolve) => server.close(resolve)); });

type Reply = { status: number; json: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; header?: boolean; forwarded?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `gc_session=${opts.cookie}`;
  if (opts.forwarded !== undefined) headers['x-forwarded-for'] = opts.forwarded;
  if (method !== 'GET' && opts.header !== false) headers['x-group-chat'] = '1';
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
async function signIn(): Promise<string> {
  const r = await call('POST', '/api/setup-login', { body: { code: CODE } });
  return (/gc_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '') as RegExpExecArray)[1] as string;
}
const cookieFrom = (r: Reply) => (/gc_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '') as RegExpExecArray)[1] as string;
const inviteToken = (link: string) => (/#invite=([A-Za-z0-9_-]{43})$/.exec(link) as RegExpExecArray)[1] as string;
const wrongCode = (forwarded?: string) => call('POST', '/api/setup-login', { body: { code: 'wrong-code-wrong-code' }, forwarded });
const keyIn = (card: string) => (/\/mcp\/([A-Za-z0-9_-]{43})/.exec(card) as RegExpExecArray)[1] as string;
const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
const door = (key: string) => fetch(`${base}/mcp/${key}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(ping) });

describe('web app', () => {
  it('answers the health check with security headers, and 404s unknown paths', async () => {
    const r = await call('GET', '/healthz');
    expect(r.status).toBe(200);
    expect(r.json).toBe('ok');
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await call('GET', '/nope')).status).toBe(404);
  });
  it('signs the owner in with their password, with no name or their own', async () => {
    expect((await call('POST', '/api/setup-login', { body: { code: 'wrong-code-wrong-code' } })).status).toBe(401);
    const r = await call('POST', '/api/setup-login', { body: { code: CODE } });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/gc_session=.+; HttpOnly; Secure; SameSite=Strict/);
    expect((await call('POST', '/api/setup-login', { body: { name: ' owner ', code: CODE } })).status).toBe(200);
    expect((await call('POST', '/api/setup-login', { body: { name: 'Owner', code: 'wrong-code-wrong-code' } })).json).toEqual({ error: 'That password is wrong.' });
    // The owner's password works whatever the Name box holds, since a phone may fill it from an older saved sign-in.
    const autofilled = await call('POST', '/api/setup-login', { body: { name: 'someone@example.com', code: CODE } });
    expect((await call('GET', '/api/me', { cookie: cookieFrom(autofilled) })).json.me).toEqual({ id: 1, name: 'Owner', kind: 'owner' });
    expect((await call('POST', '/api/setup-login', { body: { name: 'someone@example.com', code: 'wrong-code-wrong-code' } })).json).toEqual({ error: 'That name or password is wrong.' });
    expect((await call('GET', '/api/me', { cookie: await signIn() })).json).toEqual({ signedIn: true, appName: 'Group Chat', me: { id: 1, name: 'Owner', kind: 'owner' } });
    expect((await call('GET', '/api/me')).json).toEqual({ signedIn: false, appName: 'Group Chat' });
  });
  it("signs the owner in under the OWNER_NAME name: a wrong password is a plain 401 that never counts against the name limiter", async () => {
    deps.members.renameOwner('Alex');
    deps.nameLimiter = new RateLimiter(1, 3_600_000);
    for (const name of ['alex', 'ALEX', ' Alex ', '']) {
      const wrong = await call('POST', '/api/setup-login', { body: { name, code: 'wrong-code-wrong-code' } });
      expect(wrong.status, JSON.stringify(name)).toBe(401);
      expect(wrong.json, JSON.stringify(name)).toEqual({ error: 'That password is wrong.' });
    }
    // The limiter's one slot for that name is still free, so none of those tries was counted.
    expect(deps.nameLimiter.take('name:alex')).toBe(true);
    for (const name of ['alex', 'Alex', '']) {
      const r = await call('POST', '/api/setup-login', { body: { name, code: CODE } });
      expect(r.status, JSON.stringify(name)).toBe(200);
      expect((await call('GET', '/api/me', { cookie: cookieFrom(r) })).json.me, JSON.stringify(name)).toEqual({ id: 1, name: 'Alex', kind: 'owner' });
    }
    // The name the owner had before is an ordinary name now.
    expect((await call('POST', '/api/setup-login', { body: { name: 'Owner', code: 'wrong-code-wrong-code' } })).json).toEqual({ error: 'That name or password is wrong.' });
  });
  it("needs a session for the page's routes and the x-group-chat header on every POST", async () => {
    expect((await call('GET', '/api/messages')).status).toBe(401);
    const cookie = await signIn();
    expect((await call('POST', '/api/messages', { cookie, body: { text: 'hi' }, header: false })).status).toBe(403);
    expect((await call('POST', '/api/messages', { cookie, body: { text: 'hi' } })).status).toBe(200);
  });
  it('lets the owner post and read the thread', async () => {
    const cookie = await signIn();
    const posted = await call('POST', '/api/messages', { cookie, body: { text: 'Hello team' } });
    expect(posted.json).toMatchObject({ from: 'Owner', text: 'Hello team' });
    expect((await call('GET', '/api/messages', { cookie })).json.messages).toEqual([expect.objectContaining({ text: 'Hello team' })]);
    expect((await call('POST', '/api/messages', { cookie, body: { text: '   ' } })).status).toBe(400);
  });
  it('adds an agent and shows its join card once; the key works at the door', async () => {
    const cookie = await signIn();
    const r = await call('POST', '/api/agents', { cookie, body: { name: 'Muse' } });
    expect(r.json.member).toEqual({ id: 2, name: 'Muse', kind: 'agent', lastCheckInAt: null, revoked: false });
    expect(r.json.joinCard).toContain('http://localhost:3000/mcp/');
    expect((await door(keyIn(r.json.joinCard))).status).toBe(200);
    const list = await call('GET', '/api/members', { cookie });
    expect(list.json.members.map((m: { name: string }) => m.name)).toEqual(['Owner', 'Muse']);
    expect(list.json.budgetLeft).toBe(0);
    expect((await call('POST', '/api/agents', { cookie, body: { name: 'bad name' } })).status).toBe(400);
  });
  it("names only members who are in the chat in a new agent's join card", async () => {
    const cookie = await signIn();
    deps.members.createPerson('Ana');
    const card = (await call('POST', '/api/agents', { cookie, body: { name: 'Muse' } })).json.joinCard as string;
    expect(card).toContain('with Owner.');
    expect(card).not.toContain('Ana');
  });
  it("puts the owner's current name from OWNER_NAME on the join card, for a new agent and for a new link", async () => {
    deps.members.renameOwner('Alex');
    const cookie = await signIn();
    const created = (await call('POST', '/api/agents', { cookie, body: { name: 'Muse' } })).json.joinCard as string;
    expect(created).toContain('You are a member of Alex\'s group chat "Group Chat"');
    expect(created).toContain('with Alex.');
    const rotated = (await call('POST', '/api/agents/2/rotate', { cookie })).json.joinCard as string;
    expect(rotated).toContain('You are a member of Alex\'s group chat "Group Chat"');
  });
  it('a new link retires the old one; cutting an agent off stops its key', async () => {
    const cookie = await signIn();
    const first = keyIn((await call('POST', '/api/agents', { cookie, body: { name: 'Dots' } })).json.joinCard);
    const second = keyIn((await call('POST', '/api/agents/2/rotate', { cookie })).json.joinCard);
    expect((await door(first)).status).toBe(401);
    expect((await door(second)).status).toBe(200);
    expect((await call('POST', '/api/agents/2/revoke', { cookie })).status).toBe(200);
    expect((await door(second)).status).toBe(401);
  });
  it('lets the owner decide request cards and change the limits', async () => {
    const cookie = await signIn();
    deps.members.createAgent('Grokbot');
    deps.chat.postAsOwner(deps.members.owner(), 'Plan');
    const card = deps.chat.requestApproval(deps.members.byName('Grokbot')!, 'Post the plan') as { card_id: number };
    expect((await call('POST', `/api/requests/${card.card_id}/decide`, { cookie, body: { decision: 'maybe' } })).status).toBe(400);
    const decided = await call('POST', `/api/requests/${card.card_id}/decide`, { cookie, body: { decision: 'approved' } });
    expect(decided.json).toMatchObject({ kind: 'system', text: `Owner approved request #${card.card_id}: Post the plan` });
    expect((await call('POST', '/api/settings', { cookie, body: { reply_budget: 5 } })).json).toEqual({ reply_budget: 5, max_handoffs: 3, daily_cap: 60 });
    expect((await call('POST', '/api/settings', { cookie, body: { reply_budget: 0 } })).status).toBe(400);
    expect((await call('GET', '/api/settings', { cookie })).json.reply_budget).toBe(5);
  });
  it('rate-limits sign-in attempts and signs out', async () => {
    deps.loginLimiter = new RateLimiter(2, 60_000);
    await call('POST', '/api/setup-login', { body: { code: 'wrong-code-wrong-code' } });
    const cookie = await signIn();
    expect((await call('POST', '/api/setup-login', { body: { code: CODE } })).status).toBe(429);
    const out = await call('POST', '/api/logout', { cookie });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await call('GET', '/api/messages', { cookie })).status).toBe(401);
  });
  it('never logs an agent key', async () => {
    const cookie = await signIn();
    const key = keyIn((await call('POST', '/api/agents', { cookie, body: { name: 'Duet' } })).json.joinCard);
    await door(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs.some((l) => l.includes('/mcp/[key]'))).toBe(true);
    expect(logs.some((l) => l.includes(key))).toBe(false);
  });
  it('logs a refused agent key by its shape, through the app log', async () => {
    await door('x'.repeat(43));
    expect(logs).toContain('door: refused a key from the path (43 characters, looks like [43])');
  });
  it("refuses every one of the page's routes without a session, and an agent key is not a session", async () => {
    const routes: [string, string][] = [
      ['GET', '/api/messages'], ['POST', '/api/messages'], ['GET', '/api/members'], ['POST', '/api/agents'],
      ['POST', '/api/agents/2/rotate'], ['POST', '/api/agents/2/revoke'], ['POST', '/api/requests/1/decide'],
      ['GET', '/api/settings'], ['POST', '/api/settings'],
      ['POST', '/api/people'], ['POST', '/api/people/2/invite'], ['POST', '/api/people/2/remove'],
    ];
    for (const [method, path] of routes) {
      expect((await call(method, path, method === 'POST' ? { body: {} } : {})).status, `${method} ${path}`).toBe(401);
    }
    const key = deps.members.createAgent('Grokbot').key;
    deps.chat.postAsOwner(deps.members.owner(), 'Plan');
    const card = deps.chat.requestApproval(deps.members.byName('Grokbot')!, 'Post the plan') as { card_id: number };
    expect((await call('POST', `/api/requests/${card.card_id}/decide`, { cookie: key, body: { decision: 'approved' } })).status).toBe(401);
    expect(deps.chat.get(card.card_id)?.status).toBe('pending');
  });
  it('answers 404, not 500, for odd request targets, and never treats //host/path as another path', async () => {
    const port = (server.address() as AddressInfo).port;
    const rawGet = (path: string) => new Promise<number>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', reject);
      r.end();
    });
    for (const target of ['//', '//x:abc/', '/\\', '//other-host/api/me']) expect(await rawGet(target), target).toBe(404);
    for (const target of ['*/api/me', '*:99999', '*']) expect(await rawGet(target), target).toBe(400);
    expect(logs.some((l) => l.startsWith('error on'))).toBe(false);
  });
  it("takes the caller from the second x-forwarded-for entry from the right, where Render's edge puts it", async () => {
    // Measured on Render on 2026-10-24: Cloudflare appends the caller after anything the caller sent, then Render's
    // proxy appends the Cloudflare edge address, e.g. "198.51.100.7,203.0.113.7, 198.51.100.139".
    deps.loginLimiter = new RateLimiter(2, 60_000);
    const via = (madeUp: string, edge: string) => `${madeUp}, 203.0.113.7, ${edge}`;
    expect((await wrongCode(via('198.51.100.1', '198.51.100.66'))).status, 'caller 203.0.113.7, 1st').toBe(401);
    expect((await wrongCode(via('198.51.100.2', '198.51.100.139'))).status, 'made-up entry and edge changed, 2nd').toBe(401);
    expect((await wrongCode(via('198.51.100.3, 198.51.100.4', '198.51.100.66'))).status, 'two made-up entries: still the same caller, 3rd').toBe(429);
    expect((await wrongCode('203.0.113.8, 198.51.100.66')).status, 'another caller behind the same edge').toBe(401);
    const longest = 'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255'; // the longest textual IP address
    expect(longest).toHaveLength(45);
    for (const [n, status] of [[1, 401], [2, 401], [3, 429]] as const) {
      expect((await wrongCode(`${longest}, 198.51.100.66`)).status, `a 45-character caller has its own bucket, ${n}`).toBe(status);
    }
    expect((await wrongCode()).status, "the socket address's own bucket was never touched").toBe(401);
  });
  it('uses the socket address when the caller entry is missing, not an IP address, or over 45 characters', async () => {
    deps.loginLimiter = new RateLimiter(2, 60_000);
    expect((await wrongCode('203.0.113.9')).status, 'one entry, so no caller entry: the socket address, 1st').toBe(401);
    expect((await wrongCode(`${'x'.repeat(8000)}, 198.51.100.66`)).status, 'not an IP: the socket address, 2nd').toBe(401);
    expect((await wrongCode(`::1%${'a'.repeat(42)}, 198.51.100.66`)).status, '46 characters, one over the line').toBe(429);
    expect((await wrongCode('1.2.3.4:80, 198.51.100.66')).status, 'an address with a port is not an IP').toBe(429);
    expect((await wrongCode()).status, 'no header at all: the same key').toBe(429);
  });
});

describe('a second person', () => {
  async function invite(cookie: string) {
    const r = await call('POST', '/api/people', { cookie, body: { name: 'Sarah' } });
    return { member: r.json.member, link: r.json.inviteLink as string, token: inviteToken(r.json.inviteLink) };
  }
  it('is invited with a one-time link that never reaches the server log', async () => {
    const { member, link, token } = await invite(await signIn());
    expect(member).toEqual({ id: 2, name: 'Sarah', kind: 'person', lastCheckInAt: null, revoked: false, joined: false, inviteExpiresAt: expect.any(String) });
    expect(link).toBe(`http://localhost:3000/#invite=${token}`);
    expect((await call('POST', '/api/invite/check', { body: { token } })).json).toEqual({ name: 'Sarah' });
    expect((await call('POST', '/api/invite/accept', { body: { token, password: 'short' } })).json).toEqual({ error: 'Passwords are at least 12 characters.' });
    const joined = await call('POST', '/api/invite/accept', { body: { token, password: 'a long enough password' } });
    expect(joined.json).toEqual({ ok: true, name: 'Sarah' });
    expect((await call('GET', '/api/me', { cookie: cookieFrom(joined) })).json.me).toEqual({ id: 2, name: 'Sarah', kind: 'person' });
    for (const path of ['/api/invite/check', '/api/invite/accept']) {
      expect((await call('POST', path, { body: { token, password: 'a long enough password' } })).json).toEqual({ error: INVITE_GONE });
    }
    expect(logs.some((l) => l.startsWith('POST /api/invite/accept 200'))).toBe(true);
    expect(logs.some((l) => l.includes(token))).toBe(false);
    expect(deps.chat.list().at(-1)).toMatchObject({ kind: 'system', text: "Sarah joined the chat. Agents take Sarah's instructions like Owner's." });
  });
  it('signs in by name and password, then can do everything the owner can', async () => {
    const { token } = await invite(await signIn());
    await call('POST', '/api/invite/accept', { body: { token, password: 'a long enough password' } });
    expect((await call('POST', '/api/setup-login', { body: { name: 'Sarah', code: 'the wrong password' } })).json).toEqual({ error: 'That name or password is wrong.' });
    expect((await call('POST', '/api/setup-login', { body: { name: 'Nobody', code: 'a long enough password' } })).status).toBe(401);
    const sarah = cookieFrom(await call('POST', '/api/setup-login', { body: { name: 'sarah', code: 'a long enough password' } }));
    expect((await call('POST', '/api/messages', { cookie: sarah, body: { text: 'Hi all' } })).json).toMatchObject({ from: 'Sarah', from_owner: true });
    expect((await call('POST', '/api/agents', { cookie: sarah, body: { name: 'Muse' } })).json.joinCard).toContain('Only Owner and Sarah give you instructions');
    const card = deps.chat.requestApproval(deps.members.byName('Muse')!, 'Post the plan') as { card_id: number };
    const decided = await call('POST', `/api/requests/${card.card_id}/decide`, { cookie: sarah, body: { decision: 'approved' } });
    expect(decided.json).toMatchObject({ from: 'Sarah', text: `Sarah approved request #${card.card_id}: Post the plan` });
    expect(deps.chat.get(card.card_id)).toMatchObject({ status: 'approved', decided_by: 'Sarah' });
    expect((await call('GET', '/api/settings', { cookie: sarah })).status).toBe(200);
    const listed = await call('GET', '/api/members', { cookie: sarah });
    expect(listed.json.members.map((m: { name: string }) => m.name)).toEqual(['Owner', 'Sarah', 'Muse']);
    expect(JSON.stringify(listed.json)).not.toMatch(/scrypt|hash/i);
  });
  it('is removed: signed out at once and their links die, until a new invite brings them back', async () => {
    const ownerCookie = await signIn();
    const { member, token } = await invite(ownerCookie);
    const sarah = cookieFrom(await call('POST', '/api/invite/accept', { body: { token, password: 'a long enough password' } }));
    expect((await call('POST', '/api/people/1/remove', { cookie: sarah })).json).toEqual({ error: 'There is no such person.' });
    expect((await call('POST', `/api/people/${member.id}/remove`, { cookie: sarah })).json).toEqual({ error: "You can't remove yourself." });
    const unused = inviteToken((await call('POST', `/api/people/${member.id}/invite`, { cookie: ownerCookie })).json.inviteLink);
    expect((await call('POST', `/api/people/${member.id}/remove`, { cookie: ownerCookie })).json).toEqual({ ok: true });
    expect((await call('GET', '/api/messages', { cookie: sarah })).status).toBe(401);
    expect((await call('POST', '/api/setup-login', { body: { name: 'Sarah', code: 'a long enough password' } })).status).toBe(401);
    expect((await call('POST', '/api/invite/check', { body: { token: unused } })).status).toBe(400);
    expect(deps.chat.list().at(-1)).toMatchObject({ kind: 'system', text: "Owner removed Sarah from the chat. Agents no longer take Sarah's instructions." });
    const back = inviteToken((await call('POST', `/api/people/${member.id}/invite`, { cookie: ownerCookie })).json.inviteLink);
    // A new link for a removed person is no password reset, so no renewal line: the removal line is still the latest.
    expect(deps.chat.list().at(-1)).toMatchObject({ text: "Owner removed Sarah from the chat. Agents no longer take Sarah's instructions." });
    const again = await call('POST', '/api/invite/accept', { body: { token: back, password: 'a brand new password' } });
    expect((await call('GET', '/api/messages', { cookie: cookieFrom(again) })).status).toBe(200);
    // Coming back never revives a session from before the removal.
    expect((await call('GET', '/api/messages', { cookie: sarah })).status).toBe(401);
  });
  it('a new link after joining says who made it, resets the password and signs them out elsewhere, with no join line', async () => {
    const ownerCookie = await signIn();
    const { member, token } = await invite(ownerCookie);
    const first = cookieFrom(await call('POST', '/api/invite/accept', { body: { token, password: 'a long enough password' } }));
    const lines = deps.chat.list().length;
    const fresh = inviteToken((await call('POST', `/api/people/${member.id}/invite`, { cookie: ownerCookie })).json.inviteLink);
    expect(deps.chat.list().at(-1)).toMatchObject({ kind: 'system', from: 'Owner', text: 'Owner made a new invite link for Sarah.' });
    expect((await call('GET', '/api/messages', { cookie: first })).status).toBe(200);
    const second = cookieFrom(await call('POST', '/api/invite/accept', { body: { token: fresh, password: 'a brand new password' } }));
    expect((await call('GET', '/api/messages', { cookie: first })).status).toBe(401);
    expect((await call('GET', '/api/messages', { cookie: second })).status).toBe(200);
    expect(deps.chat.list()).toHaveLength(lines + 1);
  });
  it('names whoever made a new link, and posts nothing for someone who never joined', async () => {
    const ownerCookie = await signIn();
    const { token } = await invite(ownerCookie);
    const sarah = cookieFrom(await call('POST', '/api/invite/accept', { body: { token, password: 'a long enough password' } }));
    const ana = (await call('POST', '/api/people', { cookie: sarah, body: { name: 'Ana' } })).json;
    const lines = deps.chat.list().length;
    await call('POST', `/api/people/${ana.member.id}/invite`, { cookie: sarah });
    expect(deps.chat.list()).toHaveLength(lines);
    await call('POST', '/api/invite/accept', { body: { token: inviteToken((await call('POST', `/api/people/${ana.member.id}/invite`, { cookie: sarah })).json.inviteLink), password: 'another long password' } });
    await call('POST', `/api/people/${ana.member.id}/invite`, { cookie: sarah });
    expect(deps.chat.list().at(-1)).toMatchObject({ kind: 'system', from: 'Sarah', text: 'Sarah made a new invite link for Ana.' });
  });
  it('limits sign-in tries per name as well as per address, but never for the owner', async () => {
    deps.loginLimiter = new RateLimiter(100, 60_000);
    deps.nameLimiter = new RateLimiter(2, 3_600_000);
    const { token } = await invite(await signIn());
    await call('POST', '/api/invite/accept', { body: { token, password: 'a long enough password' } });
    for (const code of ['wrong password one', 'wrong password two']) {
      expect((await call('POST', '/api/setup-login', { body: { name: 'Sarah', code } })).status).toBe(401);
    }
    expect((await call('POST', '/api/setup-login', { body: { name: 'sarah', code: 'a long enough password' } })).json)
      .toEqual({ error: 'Too many tries for that name. Wait an hour, or ask for a new invite link.' });
    // The owner's password still works with that name filled in: nobody can lock the owner out by name.
    expect((await call('POST', '/api/setup-login', { body: { name: 'sarah', code: CODE } })).status).toBe(200);
    for (const name of ['', 'Owner', ' owner ']) expect((await call('POST', '/api/setup-login', { body: { name, code: CODE } })).status, name).toBe(200);
    // Names longer than any real one share a single bucket, so junk names can't grow the limiter.
    for (const tail of ['a', 'b']) expect((await call('POST', '/api/setup-login', { body: { name: `${'x'.repeat(30)}${tail}`, code: 'some wrong password' } })).status).toBe(401);
    expect((await call('POST', '/api/setup-login', { body: { name: `${'x'.repeat(30)}c`, code: 'some wrong password' } })).status).toBe(429);
  });
  it('a request sent before a removal does nothing when its body arrives after it', async () => {
    const ownerCookie = await signIn();
    const { member, token } = await invite(ownerCookie);
    const sarah = cookieFrom(await call('POST', '/api/invite/accept', { body: { token, password: 'a long enough password' } }));
    deps.members.createAgent('Grokbot');
    deps.chat.postAsOwner(deps.members.owner(), 'Plan');
    const card = deps.chat.requestApproval(deps.members.byName('Grokbot')!, 'Post the launch thread') as { card_id: number };
    const headers = { 'content-type': 'application/json', 'x-group-chat': '1', cookie: `gc_session=${sarah}` };
    // Control: held like this but still a member, the request goes through.
    const control = heldPost(`${base}/api/messages`, headers, JSON.stringify({ text: 'still here' }));
    await headersReached();
    expect((await control.send()).status).toBe(200);
    const decide = heldPost(`${base}/api/requests/${card.card_id}/decide`, headers, JSON.stringify({ decision: 'approved' }));
    const addPerson = heldPost(`${base}/api/people`, headers, JSON.stringify({ name: 'Mallory2' }));
    await headersReached();
    expect((await call('POST', `/api/people/${member.id}/remove`, { cookie: ownerCookie })).status).toBe(200);
    expect((await decide.send()).status).toBe(401);
    expect((await addPerson.send()).status).toBe(401);
    expect(deps.chat.get(card.card_id)).toMatchObject({ status: 'pending', decided_by: null });
    expect(deps.members.byName('Mallory2')).toBeNull();
  });
  it('refuses the new POST routes without the x-group-chat header, and takes wrong types as wrong', async () => {
    const cookie = await signIn();
    for (const path of ['/api/setup-login', '/api/invite/check', '/api/invite/accept', '/api/people', '/api/people/2/invite', '/api/people/2/remove']) {
      expect((await call('POST', path, { cookie, body: {}, header: false })).status, path).toBe(403);
    }
    expect((await call('POST', '/api/setup-login', { body: { name: 5, code: 5 } })).status).toBe(401);
    expect((await call('POST', '/api/invite/check', { body: { token: 5 } })).status).toBe(400);
    expect((await call('POST', '/api/invite/accept', { body: { token: 'x'.repeat(43), password: 5 } })).status).toBe(400);
    expect((await call('POST', '/api/people', { cookie, body: { name: 5 } })).status).toBe(400);
  });
  it('needs someone signed in for the people routes, and counts invite tries against the sign-in limit', async () => {
    expect((await call('POST', '/api/people', { body: { name: 'Sarah' } })).status).toBe(401);
    expect((await call('POST', '/api/people/2/invite')).status).toBe(401);
    deps.loginLimiter = new RateLimiter(2, 60_000);
    await call('POST', '/api/invite/check', { body: { token: 'x'.repeat(43) } });
    await call('POST', '/api/invite/accept', { body: { token: 'x'.repeat(43), password: 'a long enough password' } });
    expect((await call('POST', '/api/invite/check', { body: { token: 'x'.repeat(43) } })).status).toBe(429);
  });
});
