import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { type Db, openDb } from '../src/db.js';
import { type Member, Members } from '../src/members.js';
import { RateLimiter } from '../src/ratelimit.js';
import { Sessions } from '../src/sessions.js';
import { Settings } from '../src/settings.js';
import { fetchPoster, type Poster, seal, unseal, WakeError, wakeHeaders, wakeOnTag, wakeRoutes, Wakes } from '../src/wake.js';
import { createApp } from '../src/web.js';

const DATA_KEY = 'data-key-0123456789-abcdefgh';
const HOOK = 'https://hooks.example.com/webhook/routine-123';
const WAKE_KEY = 'test_wake_key_0123456789';
let db: Db;
let now: Date;
let members: Members;
let chat: Chat;
let grok: Member;
let posts: { url: string; key: string; body: string }[];
let answer: number;
let scheduled: { fn: () => void; ms: number }[];
let wakes: Wakes;

beforeEach(() => {
  db = openDb(':memory:');
  now = new Date('2026-10-23T15:00:00Z');
  const clock = () => now;
  members = new Members(db, clock);
  chat = new Chat(db, members, new Settings(db), clock);
  grok = members.createAgent('Grokbot').member;
  members.createAgent('Muse');
  posts = [];
  answer = 200;
  scheduled = [];
  const poster: Poster = async (url, key, body) => { posts.push({ url, key, body }); return answer; };
  wakes = new Wakes(db, members, clock, DATA_KEY, poster, (fn, ms) => { scheduled.push({ fn, ms }); });
});

const grokStatus = () => wakes.statuses().find((s) => s.name === 'Grokbot');
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('sealing secrets', () => {
  it('round-trips, differs every time, and fails with another DATA_KEY or a changed byte', () => {
    const a = seal(DATA_KEY, 'secret-value');
    expect(a).not.toContain('secret-value');
    expect(seal(DATA_KEY, 'secret-value')).not.toBe(a);
    expect(unseal(DATA_KEY, a)).toBe('secret-value');
    expect(() => unseal('another-data-key-0123456789', a)).toThrow();
    const raw = Buffer.from(a, 'base64url');
    raw[raw.length - 1] ^= 1;
    expect(() => unseal(DATA_KEY, raw.toString('base64url'))).toThrow();
  });
});

describe('Wakes', () => {
  it('saves a wake link only with DATA_KEY, an https address and a sane key, and stores the key encrypted', () => {
    const noKey = new Wakes(db, members, () => now, null);
    expect(() => noKey.set(grok.id, HOOK, WAKE_KEY)).toThrow(/DATA_KEY/);
    expect(() => wakes.set(grok.id, 'http://insecure.example.com/hook', WAKE_KEY)).toThrow(WakeError);
    expect(() => wakes.set(grok.id, HOOK, 'has a space')).toThrow(/key/);
    expect(() => wakes.set(1, HOOK, WAKE_KEY)).toThrow(/no such agent/);
    wakes.set(grok.id, HOOK, WAKE_KEY);
    const row = db.prepare('SELECT wake_key_sealed FROM members WHERE id = ?').get(grok.id) as { wake_key_sealed: string };
    expect(row.wake_key_sealed).not.toContain(WAKE_KEY);
    expect(unseal(DATA_KEY, row.wake_key_sealed)).toBe(WAKE_KEY);
    expect(grokStatus()).toEqual({ memberId: grok.id, name: 'Grokbot', configured: true, lastWakeAt: null, lastWakeStatus: null });
    expect(JSON.stringify(wakes.statuses())).not.toContain(WAKE_KEY);
    expect(JSON.stringify(wakes.statuses())).not.toContain(HOOK);
  });
  it("the owner's tag wakes the agent with its key, and the body carries no message text", async () => {
    wakes.set(grok.id, HOOK, WAKE_KEY);
    const m = chat.postAsOwner(members.owner(), '@Grokbot what is trending about agents?');
    expect(await wakes.onMessage(m)).toEqual({ Grokbot: 'woken' });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ url: HOOK, key: WAKE_KEY });
    const body = JSON.parse(posts[0]!.body);
    expect(body).toEqual({ event: 'tagged', message_id: m.id, from: 'Owner', note: expect.stringContaining('read_new_messages') });
    expect(posts[0]!.body).not.toContain('trending');
    expect(grokStatus()).toMatchObject({ lastWakeStatus: 'woken', lastWakeAt: now.toISOString() });
  });
  it("another person's tag wakes the agent too, and the note names who tagged it", async () => {
    wakes.set(grok.id, HOOK, WAKE_KEY);
    const { token } = members.createPerson('Sarah');
    const sarah = (await members.acceptInvite(token, 'a long enough password')).member;
    const m = chat.postAsOwner(sarah, '@Grokbot find three hooks');
    expect(await wakes.onMessage(m)).toEqual({ Grokbot: 'woken' });
    expect(JSON.parse(posts[0]!.body)).toEqual({
      event: 'tagged', message_id: m.id, from: 'Sarah',
      note: 'Sarah tagged you in the group chat. Call read_new_messages on the group chat connector now and reply.',
    });
  });
  it('untagged messages, agent mentions and revoked agents never wake; @everyone wakes every agent with a link', async () => {
    wakes.set(grok.id, HOOK, WAKE_KEY);
    expect(await wakes.onMessage(chat.postAsOwner(members.owner(), 'Morning all'))).toEqual({});
    const reply = chat.postAsAgent(members.byName('Muse') as Member, 'Hey @Grokbot, look at this') as { id: number };
    expect(await wakes.onMessage(chat.get(reply.id)!)).toEqual({});
    expect(await wakes.onMessage(chat.postAsOwner(members.owner(), '@everyone check in'))).toEqual({ Grokbot: 'woken' });
    members.revoke(grok.id);
    now = new Date(now.getTime() + 60_000);
    expect(await wakes.onMessage(chat.postAsOwner(members.owner(), '@Grokbot again'))).toEqual({});
    expect(posts).toHaveLength(1);
  });
  it("turns the routine's answer into a status the owner can read", async () => {
    wakes.set(grok.id, HOOK, WAKE_KEY);
    const cases: [number, string][] = [[400, 'routine_off'], [401, 'key_rejected'], [403, 'key_rejected'], [0, 'failed'], [302, 'failed'], [500, 'failed'], [202, 'woken']];
    for (const [status, expected] of cases) {
      answer = status;
      now = new Date(now.getTime() + 60_000);
      expect(await wakes.onMessage(chat.postAsOwner(members.owner(), '@Grokbot ping'))).toEqual({ Grokbot: expected });
      expect(grokStatus()?.lastWakeStatus).toBe(expected);
    }
  });
  it('a second tag within 30 seconds queues exactly one follow-up wake', async () => {
    wakes.set(grok.id, HOOK, WAKE_KEY);
    await wakes.onMessage(chat.postAsOwner(members.owner(), '@Grokbot one'));
    now = new Date(now.getTime() + 10_000);
    expect(await wakes.onMessage(chat.postAsOwner(members.owner(), '@Grokbot two'))).toEqual({ Grokbot: 'queued' });
    expect(await wakes.onMessage(chat.postAsOwner(members.owner(), '@Grokbot three'))).toEqual({ Grokbot: 'queued' });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(20_000);
    expect(posts).toHaveLength(1);
    now = new Date(now.getTime() + 20_000);
    scheduled[0]!.fn();
    await settle();
    expect(posts).toHaveLength(2);
    expect(grokStatus()?.lastWakeStatus).toBe('woken');
  });
  it('a queued follow-up never wakes an agent revoked in the meantime', async () => {
    wakes.set(grok.id, HOOK, WAKE_KEY);
    await wakes.onMessage(chat.postAsOwner(members.owner(), '@Grokbot one'));
    now = new Date(now.getTime() + 10_000);
    expect(await wakes.onMessage(chat.postAsOwner(members.owner(), '@Grokbot two'))).toEqual({ Grokbot: 'queued' });
    members.revoke(grok.id);
    now = new Date(now.getTime() + 20_000);
    scheduled[0]!.fn();
    await settle();
    expect(posts).toHaveLength(1);
  });
  it('wakeOnTag wires the chat to the wakes and logs failures by name, never with the key', async () => {
    wakes.set(grok.id, HOOK, WAKE_KEY);
    const logs: string[] = [];
    wakeOnTag(chat, wakes, (line) => logs.push(line));
    chat.postAsOwner(members.owner(), '@Grokbot hello');
    await settle();
    expect(posts).toHaveLength(1);
    expect(logs).toEqual([]);
    answer = 401;
    now = new Date(now.getTime() + 60_000);
    chat.postAsOwner(members.owner(), '@Grokbot again');
    await settle();
    expect(logs).toEqual(['wake Grokbot: key_rejected']);
  });
  it('routes: need a session; save, list and clear; never echo the key', async () => {
    const sessions = new Sessions(db, () => now);
    const token = sessions.create(1);
    const server = createServer(createApp({
      config: loadConfig({ APP_ORIGIN: 'http://localhost:3000', SETUP_CODE: 'setup-code-0123456789-abcdef', DATA_KEY }),
      members, chat, settings: new Settings(db), sessions,
      doorLimiter: new RateLimiter(60, 60_000), loginLimiter: new RateLimiter(10, 60_000), nameLimiter: new RateLimiter(20, 3_600_000), version: 'test', log: () => {},
      extraRoutes: [wakeRoutes(wakes)],
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { 'content-type': 'application/json', 'x-group-chat': '1', cookie: `gc_session=${token}` };
    expect((await fetch(`${base}/api/wakes`)).status).toBe(401);
    expect((await fetch(`${base}/api/agents/${grok.id}/wake`, { method: 'POST', headers, body: JSON.stringify({ url: HOOK, key: WAKE_KEY }) })).status).toBe(200);
    const listed = await (await fetch(`${base}/api/wakes`, { headers })).text();
    expect(listed).toContain('"configured":true');
    expect(listed).not.toContain(WAKE_KEY);
    expect((await fetch(`${base}/api/agents/${grok.id}/wake`, { method: 'POST', headers, body: JSON.stringify({ url: 'http://x', key: WAKE_KEY }) })).status).toBe(400);
    expect((await fetch(`${base}/api/agents/${grok.id}/wake/clear`, { method: 'POST', headers })).status).toBe(200);
    expect(grokStatus()?.configured).toBe(false);
    await new Promise((resolve) => server.close(resolve));
  });
});

describe('wakeHeaders', () => {
  const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire';

  it('adds the headers Anthropic requires to a Claude scheduled task wake', () => {
    expect(wakeHeaders(FIRE, 'routine-token-example')).toEqual({
      authorization: 'Bearer routine-token-example',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
    });
  });

  it('matches the host however it is cased', () => {
    expect(wakeHeaders('https://API.Anthropic.com/v1/claude_code/routines/trig_1/fire', 'k')['anthropic-version']).toBe('2023-06-01');
  });

  it('sends only the key and type to every other host', () => {
    expect(wakeHeaders(HOOK, WAKE_KEY)).toEqual({ authorization: `Bearer ${WAKE_KEY}`, 'content-type': 'application/json' });
    expect(wakeHeaders('https://api.anthropic.com.example.net/fire', 'k')).not.toHaveProperty('anthropic-version');
    expect(wakeHeaders('https://console.anthropic.com/fire', 'k')).not.toHaveProperty('anthropic-version');
    expect(wakeHeaders('not a url', 'k')).not.toHaveProperty('anthropic-version');
  });
});

describe('fetchPoster', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts the body with the wake headers and returns the status', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: 400 }); });
    const fire = 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire';
    expect(await fetchPoster(fire, 'routine-token-example', '{"event":"tagged"}')).toBe(400);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(fire);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toEqual(wakeHeaders(fire, 'routine-token-example'));
    expect(calls[0]?.init.body).toBe('{"event":"tagged"}');
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns 0 when the call itself fails', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    expect(await fetchPoster(HOOK, WAKE_KEY, '{}')).toBe(0);
  });
});
