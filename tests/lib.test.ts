import { describe, expect, it } from 'vitest';
import {
  activePeople, AGENT_COLORS, agentStatus, budgetLine, cardLabel, colorFor, connectedCount, connectedLine, dayLabel, initialOf,
  keyFromCard, membersKey, mergeMessages, myName, personStatus, requestParts, setMe, setMembers, timeAgo, wakeLabel, wakeLine,
} from '../public/lib.js';
import { joinCard } from '../src/joincard.js';

describe('page helpers', () => {
  it('keyFromCard takes the code after /mcp/ from a join card, never from the events link', () => {
    const key = `${'A'.repeat(20)}-_${'b'.repeat(21)}`;
    const card = joinCard({ appOrigin: 'https://chat.example.com', appName: 'Group Chat', agentName: 'Muse', ownerName: 'Owner', key, memberNames: ['Owner', 'Muse'], people: ['Owner'] });
    expect(keyFromCard(card)).toBe(key);
    expect(keyFromCard(card.replace(/\/mcp\//, '/elsewhere/')), 'only the events link is left').toBe('');
    expect(keyFromCard('no link here')).toBe('');
  });
  it('timeAgo', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    expect(timeAgo(null, now)).toBe('never');
    expect(timeAgo('2026-10-23T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-10-23T11:55:00Z', now)).toBe('5 min ago');
    expect(timeAgo('2026-10-23T09:00:00Z', now)).toBe('3 h ago');
  });
  it('mergeMessages keeps one copy per id, newest copy wins, ordered by id', () => {
    const merged = mergeMessages([{ id: 2, text: 'b' }, { id: 1, text: 'a' }], [{ id: 2, text: 'b2' }, { id: 3, text: 'c' }]);
    expect(merged).toEqual([{ id: 1, text: 'a' }, { id: 2, text: 'b2' }, { id: 3, text: 'c' }]);
  });
  it('cardLabel names who decided, and calls the signed-in person "you"', () => {
    setMe({ id: 1, name: 'Owner', kind: 'owner' });
    expect(myName()).toBe('Owner');
    expect(cardLabel('pending', null)).toBe('Waiting for your OK');
    expect(cardLabel('approved', null)).toBe('Approved');
    expect(cardLabel('declined', null)).toBe('Declined');
    expect(cardLabel('approved', 'Owner')).toBe('Approved by you');
    expect(cardLabel('declined', 'Owner')).toBe('Declined');
    expect(cardLabel('approved', 'Sarah')).toBe('Approved by Sarah');
    expect(cardLabel('declined', 'Sarah')).toBe('Declined by Sarah');
    setMe({ id: 2, name: 'Sarah', kind: 'person' });
    expect(cardLabel('approved', 'Sarah')).toBe('Approved by you');
    expect(cardLabel('approved', 'Owner')).toBe('Approved by Owner');
  });
  it('wakeLabel', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    expect(wakeLabel(undefined, now)).toBe('');
    expect(wakeLabel({ configured: false }, now)).toBe('');
    expect(wakeLabel({ configured: true, lastWakeStatus: null, lastWakeAt: null }, now)).toBe('wake link saved');
    expect(wakeLabel({ configured: true, lastWakeStatus: 'woken', lastWakeAt: '2026-10-23T11:55:00Z' }, now)).toBe('woke it (5 min ago)');
    expect(wakeLabel({ configured: true, lastWakeStatus: 'routine_off', lastWakeAt: '2026-10-23T11:59:30Z' }, now)).toBe('routine is off (just now)');
  });
  it('colorFor: people are blue, agents take the six colors in the order they were added, unknown names are gray', () => {
    setMembers([
      { id: 1, name: 'Owner', kind: 'owner' },
      { id: 5, name: 'Duet', kind: 'agent' },
      { id: 2, name: 'Muse', kind: 'agent' },
      { id: 3, name: 'Grokbot', kind: 'agent' },
      { id: 6, name: 'Sarah', kind: 'person' },
      { id: 4, name: 'Dot', kind: 'agent' },
    ]);
    expect(colorFor('Owner')).toBe('blue');
    expect(colorFor('Sarah')).toBe('blue');
    expect(['Muse', 'Grokbot', 'Dot', 'Duet'].map(colorFor)).toEqual(['teal', 'purple', 'coral', 'pink']);
    expect(colorFor('Stranger')).toBe('gray');
    const before = membersKey();
    setMembers(Array.from({ length: 7 }, (_, i) => ({ id: i + 2, name: `A${i}`, kind: 'agent' })));
    expect(colorFor('A6')).toBe(AGENT_COLORS[0]);
    expect(membersKey()).not.toBe(before);
    // Adding only a person must change the key too, so the thread recolors their messages.
    setMembers([{ id: 1, name: 'Owner', kind: 'owner' }]);
    const ownerOnly = membersKey();
    setMembers([{ id: 1, name: 'Owner', kind: 'owner' }, { id: 2, name: 'Sarah', kind: 'person' }]);
    expect(membersKey()).not.toBe(ownerOnly);
  });
  it('colorFor: the signed-in person is blue even before the members load', () => {
    setMembers([]);
    setMe({ id: 1, name: 'Alex', kind: 'owner' });
    expect(colorFor('Alex')).toBe('blue');
    expect(colorFor('Stranger')).toBe('gray');
    setMe({ id: 2, name: 'Sarah', kind: 'person' });
    expect(colorFor('Sarah')).toBe('blue');
    expect(colorFor('Alex')).toBe('gray');
  });
  it('initialOf takes the first letter or digit, upper-cased', () => {
    expect(initialOf('grokbot')).toBe('G');
    expect(initialOf('_dot')).toBe('D');
    expect(initialOf('42x')).toBe('4');
    expect(initialOf('__')).toBe('?');
  });
  it('agentStatus and wakeLine say it in plain words', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    expect(agentStatus({ revoked: true, lastCheckInAt: '2026-10-25T11:59:00Z' }, now)).toBe('Cut off');
    expect(agentStatus({ revoked: false, lastCheckInAt: null }, now)).toBe('Never checked in');
    expect(agentStatus({ revoked: false, lastCheckInAt: '2026-10-25T11:48:00Z' }, now)).toBe('Checked in 12 min ago');
    expect(wakeLine(undefined, now)).toBe('');
    expect(wakeLine({ configured: false }, now)).toBe('');
    expect(wakeLine({ configured: true, lastWakeStatus: null, lastWakeAt: null }, now)).toBe('Wakes when tagged');
    expect(wakeLine({ configured: true, lastWakeStatus: 'woken', lastWakeAt: '2026-10-25T11:55:00Z' }, now))
      .toBe('Wakes when tagged · woke it (5 min ago)');
  });
  it('connectedLine counts agents that are not cut off and have checked in', () => {
    const live = { kind: 'agent', revoked: false, lastCheckInAt: '2026-10-25T11:00:00Z' };
    const members = [
      { kind: 'owner', revoked: false, lastCheckInAt: null },
      live,
      { kind: 'agent', revoked: true, lastCheckInAt: '2026-10-25T11:00:00Z' },
      { kind: 'agent', revoked: false, lastCheckInAt: null },
    ];
    expect(connectedCount(members)).toBe(1);
    expect(connectedLine(members)).toBe('1 agent connected');
    expect(connectedLine([live, live])).toBe('2 agents connected');
    expect(connectedLine([])).toBe('No agents connected yet');
  });
  it('budgetLine says how many replies agents have left, to one person or more', () => {
    expect(budgetLine(5)).toBe('Agents can send 5 more replies until you write again.');
    expect(budgetLine(1, 1)).toBe('Agents can send 1 more reply until you write again.');
    expect(budgetLine(0)).toBe("Agents can't reply until you write again.");
    expect(budgetLine(5, 2)).toBe('Agents can send 5 more replies until one of you writes again.');
    expect(budgetLine(0, 2)).toBe("Agents can't reply until one of you writes again.");
  });
  it('activePeople and personStatus describe the people', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    const owner = { id: 1, name: 'Owner', kind: 'owner', revoked: false };
    const joined = { id: 2, name: 'Sarah', kind: 'person', revoked: false, joined: true, inviteExpiresAt: null };
    const invited = { id: 3, name: 'Ana', kind: 'person', revoked: false, joined: false, inviteExpiresAt: '2026-10-30T12:00:00Z' };
    const expired = { id: 4, name: 'Bo', kind: 'person', revoked: false, joined: false, inviteExpiresAt: '2026-10-25T11:00:00Z' };
    const removed = { id: 5, name: 'Cy', kind: 'person', revoked: true, joined: false, inviteExpiresAt: null };
    const agent = { id: 6, name: 'Muse', kind: 'agent', revoked: false };
    expect(activePeople([owner, joined, invited, expired, removed, agent]).map((m: { name: string }) => m.name)).toEqual(['Owner', 'Sarah']);
    setMe({ id: 2, name: 'Sarah', kind: 'person' });
    expect([owner, joined, invited, expired, removed].map((m) => personStatus(m, now)))
      .toEqual(['Set up this chat', 'You', 'Invited · link not used yet', 'Invite link expired', 'Removed']);
    setMe({ id: 1, name: 'Owner', kind: 'owner' });
    expect([owner, joined].map((m) => personStatus(m, now))).toEqual(['You', 'Joined']);
    expect(personStatus({ ...joined, inviteExpiresAt: '2026-10-30T12:00:00Z' }, now)).toBe('Joined · new link waiting');
    expect(personStatus({ ...removed, inviteExpiresAt: '2026-10-30T12:00:00Z' }, now)).toBe('Removed · new link waiting');
  });
  it('requestParts splits a request card text', () => {
    expect(requestParts('Request: Post the thread')).toEqual({ askedBy: null, action: 'Post the thread' });
    expect(requestParts('Request (asked by Dot): Send it\nnow')).toEqual({ askedBy: 'Dot', action: 'Send it\nnow' });
    expect(requestParts('Something else')).toEqual({ askedBy: null, action: 'Something else' });
  });
  it('dayLabel says Today, Yesterday or a short date, in local time', () => {
    const now = new Date(2026, 9, 25, 9, 0);
    expect(dayLabel(new Date(2026, 9, 25, 0, 5).toISOString(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 24, 23, 55).toISOString(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 3, 12, 0).toISOString(), now)).toBe('Oct 3');
    expect(dayLabel(new Date(2025, 11, 31, 12, 0).toISOString(), now)).toBe('Dec 31, 2025');
  });
});
