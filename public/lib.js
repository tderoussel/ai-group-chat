/** "just now", "5 min ago", "3 h ago", a date, or "never". */
export function timeAgo(iso, now = new Date()) {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Adds incoming messages: one copy per id, the newest copy wins (a decided card replaces the pending one), ordered by id. */
export function mergeMessages(list, incoming) {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * A request card's state in words. `decidedBy` is who approved or declined it: the signed-in person reads it as "you",
 * and a card with nobody recorded (decided while an older version ran) names nobody.
 */
export function cardLabel(status, decidedBy) {
  if (status !== 'approved' && status !== 'declined') return 'Waiting for your OK';
  if (!decidedBy) return status === 'approved' ? 'Approved' : 'Declined';
  if (decidedBy === myName()) return status === 'approved' ? 'Approved by you' : 'Declined';
  return `${status === 'approved' ? 'Approved' : 'Declined'} by ${decidedBy}`;
}

const WAKE_WORDS = {
  sending: 'waking it',
  woken: 'woke it',
  queued: 'wake queued',
  routine_off: 'routine is off',
  key_rejected: 'wake key rejected',
  failed: 'wake failed',
};

/** The wake-link status, e.g. "woke it (5 min ago)". Empty when the agent has no wake link. */
export function wakeLabel(wake, now = new Date()) {
  if (!wake || !wake.configured) return '';
  if (!wake.lastWakeStatus) return 'wake link saved';
  return `${WAKE_WORDS[wake.lastWakeStatus] ?? wake.lastWakeStatus} (${timeAgo(wake.lastWakeAt, now)})`;
}

/** The agent key in a join card's connector link, for apps that ask for an API key on its own. Empty when there is none. */
export function keyFromCard(card) {
  return /\/mcp\/([A-Za-z0-9_-]{20,200})/.exec(card)?.[1] ?? '';
}

/** The six agent colors, given out in the order agents were added. People are always blue; a name not known yet is gray. */
export const AGENT_COLORS = ['teal', 'purple', 'coral', 'pink', 'amber', 'green'];

let agentNames = [];
let peopleNames = [];
let me = null;

/** Remembers the agents in the order they were added (by id), and the people. Agents are never deleted, so each keeps its color. */
export function setMembers(members) {
  agentNames = members.filter((m) => m.kind === 'agent').sort((a, b) => a.id - b.id).map((m) => m.name);
  peopleNames = members.filter((m) => m.kind !== 'agent').map((m) => m.name);
}

/** Changes whenever setMembers learns a different list, so the thread knows its colors changed. */
export function membersKey() {
  return `${agentNames.join('\n')}|${peopleNames.join('\n')}`;
}

/** Remembers who is signed in ({ id, name, kind } from /api/me). Their own messages sit on the right. */
export function setMe(person) {
  me = person;
}

/** The signed-in person's name, or '' before anyone signs in. */
export function myName() {
  return me?.name ?? '';
}

/** A member's palette key: blue for people (and for the signed-in person before the members load), an agent's color by the order it was added, gray for a name not known yet. */
export function colorFor(name) {
  if (peopleNames.includes(name) || name === myName()) return 'blue';
  const i = agentNames.indexOf(name);
  return i === -1 ? 'gray' : AGENT_COLORS[i % AGENT_COLORS.length];
}

/** The letter in a member's avatar: the first letter or digit of the name, upper-cased, or "?" when there is none. */
export function initialOf(name) {
  const ch = /[\p{L}\p{N}]/u.exec(name)?.[0];
  return ch ? ch.toUpperCase() : '?';
}

/** An agent's status in plain words. */
export function agentStatus(member, now = new Date()) {
  if (member.revoked) return 'Cut off';
  if (!member.lastCheckInAt) return 'Never checked in';
  return `Checked in ${timeAgo(member.lastCheckInAt, now)}`;
}

/** The line under an agent that has a wake link, e.g. "Wakes when tagged · woke it (5 min ago)". Empty without one. */
export function wakeLine(wake, now = new Date()) {
  const label = wakeLabel(wake, now);
  if (!label) return '';
  return label === 'wake link saved' ? 'Wakes when tagged' : `Wakes when tagged · ${label}`;
}

/** Agents that are connected: not cut off and checked in at least once. */
export function connectedCount(members) {
  return members.filter((m) => m.kind === 'agent' && !m.revoked && m.lastCheckInAt).length;
}

/** The top bar's line under the app's name. */
export function connectedLine(members) {
  const n = connectedCount(members);
  if (n === 0) return 'No agents connected yet';
  return `${n} ${n === 1 ? 'agent' : 'agents'} connected`;
}

/** The Agents screen's line about the reply limit. `people` is how many people can write. */
export function budgetLine(budgetLeft, people = 1) {
  const until = people > 1 ? 'until one of you writes again' : 'until you write again';
  if (budgetLeft <= 0) return `Agents can't reply ${until}.`;
  return `Agents can send ${budgetLeft} more ${budgetLeft === 1 ? 'reply' : 'replies'} ${until}.`;
}

/** The people who can write: the owner, and everyone who joined and wasn't removed. */
export function activePeople(members) {
  return members.filter((m) => m.kind === 'owner' || (m.kind === 'person' && m.joined && !m.revoked));
}

/** A person's status in plain words. */
export function personStatus(member, now = new Date()) {
  if (member.name === myName()) return 'You';
  if (member.kind === 'owner') return 'Set up this chat';
  const linkWaiting = Boolean(member.inviteExpiresAt) && new Date(member.inviteExpiresAt) > now;
  if (member.revoked) return linkWaiting ? 'Removed · new link waiting' : 'Removed';
  if (member.joined) return linkWaiting ? 'Joined · new link waiting' : 'Joined';
  return linkWaiting ? 'Invited · link not used yet' : 'Invite link expired';
}

/** Splits a request card's text, "Request: action" or "Request (asked by X): action". Linear time (see the adversarial test). */
export function requestParts(text) {
  const m = /^Request(?: \(asked by (.+?)\))?: ([\s\S]*)$/.exec(text);
  return m ? { askedBy: m[1] ?? null, action: m[2] ?? '' } : { askedBy: null, action: text };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The date line for a message: "Today", "Yesterday", or a short date with the year when it isn't this year. Local time. */
export function dayLabel(iso, now = new Date()) {
  const day = new Date(iso);
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(day)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const date = `${MONTHS[day.getMonth()]} ${day.getDate()}`;
  return day.getFullYear() === now.getFullYear() ? date : `${date}, ${day.getFullYear()}`;
}

/** Makes an element with an optional class and text. Page only; the tests don't call it. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A round avatar with the member's initial, in the member's color. Page only. */
export function avatarEl(name) {
  const a = el('span', 'avatar', initialOf(name));
  a.dataset.color = colorFor(name);
  a.setAttribute('aria-hidden', 'true');
  return a;
}
