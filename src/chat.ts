import { EventEmitter } from 'node:events';
import { type Clock, localDate } from './clock.js';
import { type Db, tx } from './db.js';
import { rulesFor } from './joincard.js';
import { isOwner, type Member, type Members } from './members.js';
import { parseMentions } from './mentions.js';
import type { Settings } from './settings.js';

export type MessageKind = 'message' | 'request' | 'system';
export type RequestStatus = 'pending' | 'approved' | 'declined';

/** A message as both doors show it. `status` and `decided_by` are present on request cards only. */
export type ChatMessage = {
  id: number;
  from: string;
  /** True when a person still in the chat (the owner, or someone added and not removed) wrote it: agents take these as instructions. */
  from_owner: boolean;
  at: string;
  kind: MessageKind;
  text: string;
  mentions: string[];
  reply_to: number | null;
  status?: RequestStatus;
  /** Who approved or declined the card; null while it's pending. */
  decided_by?: string | null;
};

export type Refusal = { refused: 'budget' | 'handoffs' | 'daily_cap' | 'too_long'; reason: string };
export type PostResult = { id: number; handoff_depth: number } | Refusal;
export type CardResult = { card_id: number } | Refusal;
export type ReadResult = { messages: ChatMessage[]; you_were_mentioned: boolean; budget_left: number; more: boolean; rules: string };

export const MAX_TEXT = 4000;
export const MAX_ACTION = 1000;

/** Input the caller got wrong: empty text, a reply to a missing message, a card already decided. */
export class ChatError extends Error {}

const SELECT = `SELECT m.id, a.name AS author, a.kind AS author_kind, a.revoked_at AS author_removed_at, m.created_at, m.kind, m.text, m.mentions, m.reply_to,
  r.status, d.name AS decided_by
  FROM messages m JOIN members a ON a.id = m.author_id LEFT JOIN requests r ON r.message_id = m.id LEFT JOIN members d ON d.id = r.decided_by`;

type Row = {
  id: number; author: string; author_kind: string; author_removed_at: string | null; created_at: string; kind: MessageKind; text: string;
  mentions: string; reply_to: number | null; status: RequestStatus | null; decided_by: string | null;
};

function toMessage(r: Row): ChatMessage {
  const m: ChatMessage = {
    id: Number(r.id),
    from: r.author,
    from_owner: r.author_kind !== 'agent' && r.author_removed_at == null,
    at: r.created_at,
    kind: r.kind,
    text: r.text,
    mentions: JSON.parse(r.mentions) as string[],
    reply_to: r.reply_to == null ? null : Number(r.reply_to),
  };
  if (r.kind === 'request') {
    m.status = r.status ?? 'pending';
    m.decided_by = r.decided_by;
  }
  return m;
}

export class Chat {
  /** Fires 'message' (ChatMessage), 'update' (a request card whose status changed) and 'checkin' ({ name, at }). */
  readonly events = new EventEmitter();

  constructor(private db: Db, private members: Members, private settings: Settings, private clock: Clock, private timeZone = 'UTC') {}

  /** A message from a person: the owner or someone added. Agents take it as instructions. */
  postAsOwner(owner: Member, text: string, replyTo?: number): ChatMessage {
    if (!isOwner(owner)) throw new ChatError('Only people in the chat can post here.');
    const clean = text.trim();
    if (!clean) throw new ChatError('Write something first.');
    if (clean.length > MAX_TEXT) throw new ChatError(`Messages are at most ${MAX_TEXT} characters.`);
    this.checkReplyTo(replyTo);
    const id = this.insert(owner.id, 'message', clean, this.mentionsIn(clean), replyTo ?? null, 0);
    return this.announce(id);
  }

  postAsAgent(agent: Member, text: string, replyTo?: number): PostResult {
    const clean = text.trim();
    if (clean.length > MAX_TEXT) return { refused: 'too_long', reason: `Messages are at most ${MAX_TEXT} characters.` };
    if (!clean) throw new ChatError('Write something first.');
    this.checkReplyTo(replyTo);
    const verdict = this.check(agent);
    if ('refused' in verdict) return verdict;
    const id = this.insert(agent.id, 'message', clean, this.mentionsIn(clean), replyTo ?? null, verdict.depth);
    this.announce(id);
    return { id, handoff_depth: verdict.depth };
  }

  /** An agent asks the people to approve an action outside the chat. Counts as a post for every limit. */
  requestApproval(agent: Member, action: string, askedBy?: string): CardResult {
    const clean = action.trim();
    if (clean.length > MAX_ACTION) return { refused: 'too_long', reason: `Requests are at most ${MAX_ACTION} characters.` };
    if (!clean) throw new ChatError('Say what you would do.');
    const verdict = this.check(agent);
    if ('refused' in verdict) return verdict;
    const asked = askedBy?.trim().slice(0, 100) || null;
    const text = asked ? `Request (asked by ${asked}): ${clean}` : `Request: ${clean}`;
    const id = tx(this.db, () => {
      const messageId = this.insert(agent.id, 'request', text, [], null, verdict.depth);
      this.db.prepare('INSERT INTO requests (message_id, action, asked_by) VALUES (?, ?, ?)').run(messageId, clean, asked);
      return messageId;
    });
    this.announce(id);
    return { card_id: id };
  }

  /** A person's decision on a request card. The agent door has no way to call this. */
  decideRequest(owner: Member, cardId: number, decision: 'approved' | 'declined'): ChatMessage {
    if (!isOwner(owner)) throw new ChatError('Only people in the chat can decide requests.');
    const row = this.db.prepare('SELECT status, action FROM requests WHERE message_id = ?').get(cardId) as
      { status: RequestStatus; action: string } | undefined;
    if (!row) throw new ChatError(`There is no request card #${cardId}.`);
    if (row.status !== 'pending') throw new ChatError(`Request card #${cardId} was already ${row.status}.`);
    const id = tx(this.db, () => {
      this.db.prepare('UPDATE requests SET status = ?, decided_at = ?, decided_by = ? WHERE message_id = ?')
        .run(decision, this.clock().toISOString(), owner.id, cardId);
      return this.insert(owner.id, 'system', `${owner.name} ${decision} request #${cardId}: ${row.action}`, [], cardId, 0);
    });
    this.events.emit('update', this.get(cardId));
    return this.announce(id);
  }

  /** Tells the chat, as the owner, that a person joined, so agents know whose instructions to take. */
  personJoined(person: Member): ChatMessage {
    const owner = this.members.owner();
    const text = `${person.name} joined the chat. Agents take ${person.name}'s instructions like ${owner.name}'s.`;
    return this.announce(this.insert(owner.id, 'system', text, [], null, 0));
  }

  /** Tells the chat that a person was removed and agents no longer take their instructions. */
  personRemoved(person: Member, by: Member): ChatMessage {
    const text = `${by.name} removed ${person.name} from the chat. Agents no longer take ${person.name}'s instructions.`;
    return this.announce(this.insert(by.id, 'system', text, [], null, 0));
  }

  /** Tells the chat who made a new invite link for someone who had joined: whoever uses it gets a new password for that account. */
  inviteRenewed(person: Member, by: Member): ChatMessage {
    return this.announce(this.insert(by.id, 'system', `${by.name} made a new invite link for ${person.name}.`, [], null, 0));
  }

  /** What's new for this agent. The read position only moves forward; the check-in time is recorded. */
  readNew(agent: Member, opts: { limit?: number; since?: number } = {}): ReadResult {
    if (opts.since !== undefined && (!Number.isSafeInteger(opts.since) || opts.since < 0)) throw new ChatError('since must be a message id: a whole number, 0 or more.');
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 50);
    const from = opts.since ?? this.members.byId(agent.id)?.readPosition ?? 0;
    const rows = this.db.prepare(`${SELECT} WHERE m.id > ? ORDER BY m.id ASC LIMIT ?`).all(from, limit + 1) as unknown as Row[];
    const messages = rows.slice(0, limit).map(toMessage);
    // The position moves only to the last message returned, never to a caller's `since`.
    const last = messages.length > 0 ? (messages[messages.length - 1] as ChatMessage).id : 0;
    const at = this.clock().toISOString();
    this.db.prepare('UPDATE members SET read_position = MAX(read_position, ?), last_check_in_at = ? WHERE id = ?').run(last, at, agent.id);
    this.events.emit('checkin', { name: agent.name, at });
    const me = agent.name.toLowerCase();
    const addressed = messages.some((m) => m.from !== agent.name && (
      m.mentions.includes(me) || m.mentions.includes('everyone') ||
      (m.from_owner && m.kind === 'message' && m.mentions.length === 0)));
    return { messages, you_were_mentioned: addressed, budget_left: this.budgetLeft(), more: rows.length > limit, rules: rulesFor(this.members.ownerNames()) };
  }

  /** For the page: the newest messages, oldest first. `before` pages back through older ones. */
  list(opts: { before?: number; limit?: number } = {}): ChatMessage[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 200);
    const rows = (opts.before
      ? this.db.prepare(`${SELECT} WHERE m.id < ? ORDER BY m.id DESC LIMIT ?`).all(opts.before, limit)
      : this.db.prepare(`${SELECT} ORDER BY m.id DESC LIMIT ?`).all(limit)) as unknown as Row[];
    return rows.map(toMessage).reverse();
  }

  get(id: number): ChatMessage | null {
    const row = this.db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as unknown as Row | undefined;
    return row ? toMessage(row) : null;
  }

  /** Posts the agents may still make before a person writes again. 0 before the first message from a person. */
  budgetLeft(): number {
    const last = this.lastOwnerMessageId();
    if (last === null) return 0;
    return Math.max(0, this.settings.get().reply_budget - this.countAgentPosts('m.id > ?', last));
  }

  private check(agent: Member): { depth: number } | Refusal {
    const limits = this.settings.get();
    if (this.lastOwnerMessageId() === null) return { refused: 'budget', reason: 'No person in the chat has written yet. Wait for one of them to write.' };
    if (this.budgetLeft() <= 0) {
      return { refused: 'budget', reason: `Agents used all ${limits.reply_budget} replies to the latest message from a person. Wait for a person to write again.` };
    }
    const depth = this.handoffDepth(agent);
    if (depth > limits.max_handoffs) {
      return { refused: 'handoffs', reason: `This chain of hand-offs between agents reached its limit of ${limits.max_handoffs}. Wait for a person to write again.` };
    }
    if (this.countAgentPosts('m.day = ?', localDate(this.clock(), this.timeZone)) >= limits.daily_cap) {
      return { refused: 'daily_cap', reason: `Agents have posted ${limits.daily_cap} times today, the daily limit. Wait for a person.` };
    }
    return { depth };
  }

  /** One more than the newest agent post since a person's latest message that names this agent or @everyone; otherwise 0. */
  private handoffDepth(agent: Member): number {
    const since = this.lastOwnerMessageId() ?? 0;
    const rows = this.db.prepare(`SELECT m.handoff_depth AS depth, m.mentions FROM messages m JOIN members a ON a.id = m.author_id
      WHERE m.id > ? AND a.kind = 'agent' AND m.author_id != ? AND m.kind IN ('message', 'request')
      ORDER BY m.id DESC`).all(since, agent.id) as { depth: number; mentions: string }[];
    const me = agent.name.toLowerCase();
    for (const r of rows) {
      const mentions = JSON.parse(r.mentions) as string[];
      if (mentions.includes(me) || mentions.includes('everyone')) return Number(r.depth) + 1;
    }
    return 0;
  }

  /** Agent posts (messages and request cards) meeting one condition on m. `where` is always a constant in this file. */
  private countAgentPosts(where: string, value: number | string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM messages m JOIN members a ON a.id = m.author_id
      WHERE a.kind = 'agent' AND m.kind IN ('message', 'request') AND ${where}`).get(value) as { n: number };
    return Number(row.n);
  }

  /** The newest message (not a card or system line) from any person, removed people included: their messages still happened. */
  private lastOwnerMessageId(): number | null {
    const row = this.db.prepare(`SELECT MAX(m.id) AS id FROM messages m JOIN members a ON a.id = m.author_id
      WHERE a.kind != 'agent' AND m.kind = 'message'`).get() as { id: number | null };
    return row.id == null ? null : Number(row.id);
  }

  private checkReplyTo(replyTo: number | undefined): void {
    if (replyTo !== undefined && !this.get(replyTo)) throw new ChatError(`There is no message #${replyTo}.`);
  }

  private mentionsIn(text: string): string[] {
    return parseMentions(text, this.members.list().map((m) => m.name));
  }

  private insert(authorId: number, kind: MessageKind, text: string, mentions: string[], replyTo: number | null, depth: number): number {
    const now = this.clock();
    const r = this.db.prepare(`INSERT INTO messages (author_id, kind, text, mentions, reply_to, handoff_depth, created_at, day)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(authorId, kind, text, JSON.stringify(mentions), replyTo, depth, now.toISOString(), localDate(now, this.timeZone));
    return Number(r.lastInsertRowid);
  }

  private announce(id: number): ChatMessage {
    const message = this.get(id) as ChatMessage;
    this.events.emit('message', message);
    return message;
  }
}
