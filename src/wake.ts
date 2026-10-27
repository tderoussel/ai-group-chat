import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Chat, ChatMessage } from './chat.js';
import type { Clock } from './clock.js';
import type { Db } from './db.js';
import { sendJson } from './http-util.js';
import type { Members } from './members.js';
import type { ExtraRoute } from './web.js';

export class WakeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const keyFrom = (dataKey: string) => Buffer.from(hkdfSync('sha256', dataKey, 'group-chat', 'seal v1', 32));

/** AES-256-GCM under a key derived from DATA_KEY. Output: base64url of iv (12 bytes) + tag (16) + ciphertext. */
export function seal(dataKey: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(dataKey), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Throws if the value was changed or sealed under another DATA_KEY. */
export function unseal(dataKey: string, sealed: string): string {
  const raw = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(dataKey), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export type WakeStatus = 'woken' | 'routine_off' | 'key_rejected' | 'failed' | 'queued';

/** Sends one wake-up. Returns the HTTP status, or 0 when the call itself failed (timeout, DNS, refused). */
export type Poster = (url: string, key: string, body: string) => Promise<number>;

/** Claude scheduled tasks wake through Anthropic's routine fire endpoint: it refuses a call without an API version (400), and the beta header is the one Anthropic's own example sends. */
const ANTHROPIC_HOST = 'api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'experimental-cc-routine-2026-04-01';

/** The headers for one wake-up: the key and type, plus Anthropic's version and beta headers when the link is Anthropic's. */
export function wakeHeaders(url: string, key: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  let host = '';
  try { host = new URL(url).hostname; } catch { host = ''; }
  if (host === ANTHROPIC_HOST) {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    headers['anthropic-beta'] = ANTHROPIC_BETA;
  }
  return headers;
}

export const fetchPoster: Poster = async (url, key, body) => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
      headers: wakeHeaders(url, key),
      body,
    });
    return res.status;
  } catch {
    return 0;
  }
};

const MIN_GAP_MS = 30_000;
const wakeNote = (from: string) => `${from} tagged you in the group chat. Call read_new_messages on the group chat connector now and reply.`;

/** Wake links: tagging an agent whose app accepts a webhook, such as a Grok Bot routine or a Claude scheduled task's API trigger, wakes it at once. */
export class Wakes {
  private queued = new Set<number>();

  constructor(
    private db: Db,
    private members: Members,
    private clock: Clock,
    private dataKey: string | null,
    private post: Poster = fetchPoster,
    private later: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms).unref(); },
  ) {}

  /** Saves an agent's wake link: its routine's webhook address and key. The key is stored encrypted. */
  set(memberId: number, url: string, key: string): void {
    if (!this.dataKey) throw new WakeError('Set DATA_KEY on the server before saving wake links.');
    const member = this.members.byId(memberId);
    if (!member || member.kind !== 'agent') throw new WakeError('There is no such agent.');
    let parsed: URL | null = null;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || url.length > 500) throw new WakeError('The wake link must be a full https:// address, at most 500 characters.');
    if (!/^\S{10,500}$/.test(key)) throw new WakeError('The wake key looks wrong: 10 to 500 characters, no spaces.');
    this.db.prepare('UPDATE members SET wake_url = ?, wake_key_sealed = ?, last_wake_at = NULL, last_wake_status = NULL WHERE id = ?')
      .run(url, seal(this.dataKey, key), memberId);
  }

  clear(memberId: number): void {
    this.db.prepare('UPDATE members SET wake_url = NULL, wake_key_sealed = NULL, last_wake_at = NULL, last_wake_status = NULL WHERE id = ?').run(memberId);
  }

  /** What the page shows for each agent. Never includes the key or the address. */
  statuses(): { memberId: number; name: string; configured: boolean; lastWakeAt: string | null; lastWakeStatus: string | null }[] {
    const rows = this.db.prepare(`SELECT id, name, wake_url, last_wake_at, last_wake_status FROM members WHERE kind = 'agent' ORDER BY id`).all() as
      { id: number; name: string; wake_url: string | null; last_wake_at: string | null; last_wake_status: string | null }[];
    return rows.map((r) => ({ memberId: Number(r.id), name: r.name, configured: r.wake_url != null, lastWakeAt: r.last_wake_at, lastWakeStatus: r.last_wake_status }));
  }

  /** Wakes each agent a person tagged (by name or @everyone) that has a wake link. */
  async onMessage(m: ChatMessage): Promise<Record<string, WakeStatus>> {
    if (!m.from_owner || m.kind !== 'message' || !this.dataKey) return {};
    const rows = this.db.prepare(`SELECT id, name FROM members WHERE kind = 'agent' AND revoked_at IS NULL AND wake_url IS NOT NULL ORDER BY id`).all() as
      { id: number; name: string }[];
    const out: Record<string, WakeStatus> = {};
    for (const r of rows) {
      if (m.mentions.includes(r.name.toLowerCase()) || m.mentions.includes('everyone')) out[r.name] = await this.wake(Number(r.id), m.id, m.from);
    }
    return out;
  }

  private async wake(memberId: number, messageId: number, from: string): Promise<WakeStatus> {
    const row = this.db.prepare('SELECT wake_url, wake_key_sealed, last_wake_at FROM members WHERE id = ? AND revoked_at IS NULL').get(memberId) as
      { wake_url: string | null; wake_key_sealed: string | null; last_wake_at: string | null } | undefined;
    if (!row?.wake_url || !row.wake_key_sealed || !this.dataKey) return 'failed';
    const now = this.clock().getTime();
    const since = row.last_wake_at ? now - Date.parse(row.last_wake_at) : Number.POSITIVE_INFINITY;
    if (since < MIN_GAP_MS) {
      if (!this.queued.has(memberId)) {
        this.queued.add(memberId);
        this.later(() => {
          this.queued.delete(memberId);
          // A failed follow-up only leaves the status at "queued"; the hourly check still runs.
          this.wake(memberId, messageId, from).catch(() => {});
        }, MIN_GAP_MS - since);
      }
      this.setStatus(memberId, 'queued');
      return 'queued';
    }
    // Claim the slot before the network call, so a tag arriving meanwhile queues instead of sending twice.
    this.db.prepare('UPDATE members SET last_wake_at = ?, last_wake_status = ? WHERE id = ?').run(new Date(now).toISOString(), 'sending', memberId);
    let status = 0;
    try {
      const key = unseal(this.dataKey, row.wake_key_sealed);
      status = await this.post(row.wake_url, key, JSON.stringify({ event: 'tagged', message_id: messageId, from, note: wakeNote(from) }));
    } catch {
      status = 0;
    }
    const result: WakeStatus = status >= 200 && status < 300 ? 'woken'
      : status === 400 ? 'routine_off'
      : status === 401 || status === 403 ? 'key_rejected'
      : 'failed';
    this.setStatus(memberId, result);
    return result;
  }

  private setStatus(memberId: number, status: string): void {
    this.db.prepare('UPDATE members SET last_wake_status = ? WHERE id = ?').run(status, memberId);
  }
}

/** Runs every message past the wakes. Failures are logged by agent name, never with the key. */
export function wakeOnTag(chat: Chat, wakes: Wakes, log: (line: string) => void): void {
  chat.events.on('message', (m: ChatMessage) => {
    wakes.onMessage(m)
      .then((result) => { for (const [name, status] of Object.entries(result)) if (status !== 'woken' && status !== 'queued') log(`wake ${name}: ${status}`); })
      .catch((e: unknown) => log(`wake error: ${e instanceof Error ? e.message : String(e)}`));
  });
}

export function wakeRoutes(wakes: Wakes): ExtraRoute {
  return async (req, res, url, ctx) => {
    const p = url.pathname;
    const set = /^\/api\/agents\/(\d+)\/wake$/.exec(p);
    const clear = /^\/api\/agents\/(\d+)\/wake\/clear$/.exec(p);
    const listing = req.method === 'GET' && p === '/api/wakes';
    if (!listing && !(req.method === 'POST' && (set || clear))) return false;
    if (!ctx.owner) { sendJson(res, 401, { error: 'Sign in first.' }); return true; }
    if (listing) { sendJson(res, 200, { wakes: wakes.statuses() }); return true; }
    if (set) {
      const { url: wakeUrl, key } = await ctx.body();
      wakes.set(Number(set[1]), typeof wakeUrl === 'string' ? wakeUrl.trim() : '', typeof key === 'string' ? key.trim() : '');
    } else {
      wakes.clear(Number((clear as RegExpExecArray)[1]));
    }
    sendJson(res, 200, { ok: true });
    return true;
  };
}
