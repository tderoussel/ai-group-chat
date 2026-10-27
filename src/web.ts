import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { type Chat, ChatError } from './chat.js';
import type { Config } from './config.js';
import { handleDoor, isDoorPath } from './door.js';
import { BodyError, readJsonBody, redactUrl, sendJson } from './http-util.js';
import { joinCard } from './joincard.js';
import { sameSecret } from './keys.js';
import { INVITE_GONE, MAX_NAME, type Member, MemberError, type Members } from './members.js';
import type { RateLimiter } from './ratelimit.js';
import { clearedSessionCookie, readCookie, SESSION_COOKIE, sessionCookie, type Sessions } from './sessions.js';
import { type Limits, type Settings, SettingsError } from './settings.js';

export type RouteContext = {
  /** The signed-in person (the owner or someone added), or null. */
  owner: Member | null;
  ip: string;
  /** The JSON body as an object (64 KB at most). */
  body: () => Promise<Record<string, unknown>>;
  /** Starts a session for this member and replies with `body`. */
  startSession: (memberId: number, status: number, body: unknown) => void;
};

/** A route added by another module (wake links, ChatGPT events). Returns true when it handled the request. */
export type ExtraRoute = (req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext) => Promise<boolean>;

export type AppDeps = {
  config: Config;
  members: Members;
  chat: Chat;
  settings: Settings;
  sessions: Sessions;
  doorLimiter: RateLimiter;
  loginLimiter: RateLimiter;
  /** Sign-in tries per name, for everyone but the owner, so a person's password can't be guessed from many addresses. */
  nameLimiter: RateLimiter;
  version: string;
  log: (line: string) => void;
  extraRoutes?: ExtraRoute[];
};

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
};

const API_BODY_MAX = 64 * 1024;
const JS = 'text/javascript; charset=utf-8';
const pub = (file: string) => new URL(`../public/${file}`, import.meta.url);

/** Every file the page uses. */
const STATIC: Record<string, [URL, string]> = {
  '/': [pub('index.html'), 'text/html; charset=utf-8'],
  '/style.css': [pub('style.css'), 'text/css; charset=utf-8'],
  '/app.js': [pub('app.js'), JS],
  '/api.js': [pub('api.js'), JS],
  '/lib.js': [pub('lib.js'), JS],
  '/login.js': [pub('login.js'), JS],
  '/thread.js': [pub('thread.js'), JS],
  '/people.js': [pub('people.js'), JS],
  '/updates.js': [pub('updates.js'), JS],
};

export function createApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const started = Date.now();
    res.on('finish', () => deps.log(`${req.method} ${redactUrl(req.url ?? '')} ${res.statusCode} ${Date.now() - started}ms`));
    handle(req, res, deps).catch((e: unknown) => {
      deps.log(`error on ${redactUrl(req.url ?? '')}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
      else res.end();
    });
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  if (isDoorPath(req.url)) {
    return handleDoor(req, res, { chat: deps.chat, members: deps.members, appOrigin: deps.config.appOrigin, limiter: deps.doorLimiter, version: deps.version, log: deps.log });
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (!(req.url ?? '/').startsWith('/')) return sendJson(res, 400, { error: 'Bad request.' });
  let url: URL;
  try {
    // No base URL: a target such as //host/path stays a path instead of naming another host.
    url = new URL(`http://local${req.url ?? '/'}`);
  } catch {
    return sendJson(res, 400, { error: 'Bad request.' });
  }
  const method = req.method ?? 'GET';
  const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
  const sessionMember = deps.sessions.memberId(cookie);
  const ctx: RouteContext = {
    owner: sessionMember === null ? null : deps.members.byId(sessionMember),
    ip: clientIp(req),
    body: async () => {
      const value = await readJsonBody(req, API_BODY_MAX);
      // A body can arrive minutes after the headers. Whoever was signed in then must still be, or nothing happens.
      if (sessionMember !== null && deps.sessions.memberId(cookie) !== sessionMember) throw new BodyError('Sign in first.', 401);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BodyError('Send a JSON object.', 400);
      return value as Record<string, unknown>;
    },
    startSession: (memberId, status, body) => sendJson(res, status, body, { 'set-cookie': sessionCookie(deps.sessions.create(memberId)) }),
  };

  if (method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      if (method !== 'GET' && req.headers['x-group-chat'] !== '1') return sendJson(res, 403, { error: 'Missing the x-group-chat header.' });
      if (await apiRoute(req, res, url, method, ctx, deps)) return;
    }
    for (const route of deps.extraRoutes ?? []) if (await route(req, res, url, ctx)) return;
  } catch (e) {
    if (e instanceof ChatError || e instanceof MemberError || e instanceof SettingsError) return sendJson(res, 400, { error: e.message });
    const status = e instanceof Error ? (e as Error & { status?: unknown }).status : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) return sendJson(res, status, { error: (e as Error).message });
    throw e;
  }
  if (method === 'GET' && (await serveStatic(res, url.pathname))) return;
  sendJson(res, 404, { error: 'Not found.' });
}

async function apiRoute(req: IncomingMessage, res: ServerResponse, url: URL, method: string, ctx: RouteContext, deps: AppDeps): Promise<boolean> {
  const p = url.pathname;
  /** The signed-in person; sends 401 and returns null when nobody is signed in. */
  const owner = (): Member | null => {
    if (ctx.owner) return ctx.owner;
    sendJson(res, 401, { error: 'Sign in first.' });
    return null;
  };
  /** Counts a sign-in or invite try against this address; sends 429 and returns false past the limit. */
  const tryAllowed = (): boolean => {
    if (deps.loginLimiter.take(`login:${ctx.ip}`)) return true;
    sendJson(res, 429, { error: 'Too many tries. Wait a minute.' });
    return false;
  };

  if (method === 'GET' && p === '/api/me') {
    const me = ctx.owner;
    sendJson(res, 200, me ? { signedIn: true, appName: deps.config.appName, me: { id: me.id, name: me.name, kind: me.kind } } : { signedIn: false, appName: deps.config.appName });
    return true;
  }
  if (method === 'POST' && p === '/api/setup-login') {
    if (!tryAllowed()) return true;
    const { name, code } = await ctx.body();
    const who = typeof name === 'string' ? name.trim() : '';
    if (typeof code !== 'string') { sendJson(res, 401, { error: 'That password is wrong.' }); return true; }
    // The owner's password is SETUP_CODE. It signs the owner in whatever the Name box holds (a phone may fill it from an
    // older saved sign-in), and before any per-name limit, so nobody can lock the owner out by name.
    if (sameSecret(code, deps.config.setupCode)) {
      ctx.startSession(deps.members.owner().id, 200, { ok: true });
      return true;
    }
    if (!who || who.toLowerCase() === deps.members.owner().name.toLowerCase()) { sendJson(res, 401, { error: 'That password is wrong.' }); return true; }
    // Anyone else signs in with the password they picked.
    // One character past the longest real name: junk names can't grow the limiter's memory or share a real person's bucket.
    if (!deps.nameLimiter.take(`name:${who.slice(0, MAX_NAME + 1).toLowerCase()}`)) {
      sendJson(res, 429, { error: 'Too many tries for that name. Wait an hour, or ask for a new invite link.' });
      return true;
    }
    const person = await deps.members.personByPassword(who, code);
    if (!person) { sendJson(res, 401, { error: 'That name or password is wrong.' }); return true; }
    ctx.startSession(person.id, 200, { ok: true });
    return true;
  }
  if (method === 'POST' && p === '/api/invite/check') {
    if (!tryAllowed()) return true;
    const { token } = await ctx.body();
    const person = typeof token === 'string' ? deps.members.personByInvite(token) : null;
    if (!person) throw new MemberError(INVITE_GONE);
    sendJson(res, 200, { name: person.name });
    return true;
  }
  if (method === 'POST' && p === '/api/invite/accept') {
    if (!tryAllowed()) return true;
    const { token, password } = await ctx.body();
    if (typeof token !== 'string') throw new MemberError(INVITE_GONE);
    if (typeof password !== 'string') throw new MemberError('Pick a password.');
    const { member, joining } = await deps.members.acceptInvite(token, password);
    // A new password signs the person out everywhere else.
    deps.sessions.removeAllFor(member.id);
    if (joining) deps.chat.personJoined(member);
    ctx.startSession(member.id, 200, { ok: true, name: member.name });
    return true;
  }
  if (method === 'POST' && p === '/api/logout') {
    deps.sessions.remove(readCookie(req.headers.cookie, SESSION_COOKIE));
    sendJson(res, 200, { ok: true }, { 'set-cookie': clearedSessionCookie() });
    return true;
  }
  if (method === 'GET' && p === '/api/messages') {
    if (!owner()) return true;
    const before = Number(url.searchParams.get('before')) || undefined;
    sendJson(res, 200, { messages: deps.chat.list({ before }) });
    return true;
  }
  if (method === 'POST' && p === '/api/messages') {
    const me = owner();
    if (!me) return true;
    const { text, reply_to } = await ctx.body();
    if (typeof text !== 'string') throw new ChatError('Send some text.');
    sendJson(res, 200, deps.chat.postAsOwner(me, text, typeof reply_to === 'number' ? reply_to : undefined));
    return true;
  }
  if (method === 'GET' && p === '/api/members') {
    if (!owner()) return true;
    sendJson(res, 200, { members: deps.members.list().map(publicMember), budgetLeft: deps.chat.budgetLeft() });
    return true;
  }
  if (method === 'POST' && p === '/api/agents') {
    if (!owner()) return true;
    const { name } = await ctx.body();
    if (typeof name !== 'string') throw new MemberError('Give the agent a name.');
    const { member, key } = deps.members.createAgent(name.trim());
    sendJson(res, 200, { member: publicMember(member), joinCard: cardFor(deps, member.name, key) });
    return true;
  }
  const agentAction = /^\/api\/agents\/(\d+)\/(rotate|revoke)$/.exec(p);
  if (method === 'POST' && agentAction) {
    if (!owner()) return true;
    const id = Number(agentAction[1]);
    if (agentAction[2] === 'revoke') {
      deps.members.revoke(id);
      sendJson(res, 200, { ok: true });
      return true;
    }
    const key = deps.members.rotateKey(id);
    const member = deps.members.byId(id) as Member;
    sendJson(res, 200, { member: publicMember(member), joinCard: cardFor(deps, member.name, key) });
    return true;
  }
  const decide = /^\/api\/requests\/(\d+)\/decide$/.exec(p);
  if (method === 'POST' && decide) {
    const me = owner();
    if (!me) return true;
    const { decision } = await ctx.body();
    if (decision !== 'approved' && decision !== 'declined') throw new ChatError('Decide "approved" or "declined".');
    sendJson(res, 200, deps.chat.decideRequest(me, Number(decide[1]), decision));
    return true;
  }
  if (method === 'POST' && p === '/api/people') {
    if (!owner()) return true;
    const { name } = await ctx.body();
    if (typeof name !== 'string') throw new MemberError('Give the person a name.');
    const { member, token } = deps.members.createPerson(name.trim());
    sendJson(res, 200, { member: publicMember(member), inviteLink: inviteLink(deps, token) });
    return true;
  }
  const personAction = /^\/api\/people\/(\d+)\/(invite|remove)$/.exec(p);
  if (method === 'POST' && personAction) {
    const me = owner();
    if (!me) return true;
    const id = Number(personAction[1]);
    if (personAction[2] === 'remove') {
      const removed = deps.members.removePerson(id, me);
      deps.sessions.removeAllFor(id);
      deps.chat.personRemoved(removed, me);
      sendJson(res, 200, { ok: true });
      return true;
    }
    const token = deps.members.newInvite(id);
    const person = deps.members.byId(id) as Member;
    // Using a new link for someone who joined replaces their password, so everyone sees who made it.
    if (person.joined) deps.chat.inviteRenewed(person, me);
    sendJson(res, 200, { member: publicMember(person), inviteLink: inviteLink(deps, token) });
    return true;
  }
  if (p === '/api/settings' && (method === 'GET' || method === 'POST')) {
    if (!owner()) return true;
    if (method === 'POST') deps.settings.update((await ctx.body()) as Partial<Limits>);
    sendJson(res, 200, deps.settings.get());
    return true;
  }
  return false;
}

/** What the page may see of a member: never a key, password or invite hash. */
function publicMember(m: Member) {
  const shown = { id: m.id, name: m.name, kind: m.kind, lastCheckInAt: m.lastCheckInAt, revoked: m.revoked };
  return m.kind === 'person' ? { ...shown, joined: m.joined, inviteExpiresAt: m.inviteExpiresAt } : shown;
}

/** The invite link. The token sits after #, which browsers never send, so it stays out of every server log. */
function inviteLink(deps: AppDeps, token: string): string {
  return `${deps.config.appOrigin}/#invite=${token}`;
}

function cardFor(deps: AppDeps, agentName: string, key: string): string {
  // Agents and people who joined: someone invited who hasn't joined isn't in the chat yet.
  const memberNames = deps.members.list().filter((m) => !m.revoked && (m.kind !== 'person' || m.joined)).map((m) => m.name);
  return joinCard({
    appOrigin: deps.config.appOrigin, appName: deps.config.appName, agentName, ownerName: deps.members.owner().name, key, memberNames, people: deps.members.ownerNames(),
  });
}

/**
 * The caller's address, used only to slow down sign-in guessing. Measured on Render on 2026-10-24: its
 * Cloudflare edge appends the caller's address after anything the caller sent in x-forwarded-for, then
 * Render's proxy appends the edge's own address. So the caller is the second entry from the right, and the
 * entries before it are whatever the caller typed. If that entry is missing, is not an IP address, or is
 * longer than 45 characters (an IPv6 zone suffix), the socket address is used, so the limiter key stays short.
 */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const entries = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').map((entry) => entry.trim());
  const caller = entries.length >= 2 ? (entries[entries.length - 2] as string) : '';
  return isIP(caller) && caller.length <= 45 ? caller : req.socket.remoteAddress || 'unknown';
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const entry = STATIC[pathname];
  if (!entry) return false;
  try {
    const body = await readFile(entry[0]);
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}
