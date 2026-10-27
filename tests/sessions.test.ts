import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Members } from '../src/members.js';
import { clearedSessionCookie, readCookie, sessionCookie, Sessions } from '../src/sessions.js';

describe('Sessions', () => {
  it('creates sessions for a member that last 30 days', () => {
    let now = new Date('2026-10-23T12:00:00Z');
    const sessions = new Sessions(openDb(':memory:'), () => now);
    const token = sessions.create(1);
    expect(sessions.memberId(token)).toBe(1);
    expect(sessions.memberId('nope')).toBeNull();
    expect(sessions.memberId(undefined)).toBeNull();
    now = new Date('2026-11-23T12:00:01Z');
    expect(sessions.memberId(token)).toBeNull();
  });
  it("removes one session on sign-out, or all of a member's sessions", () => {
    const db = openDb(':memory:');
    const sessions = new Sessions(db, () => new Date());
    const person = new Members(db, () => new Date()).createPerson('Sarah').member;
    const mine = sessions.create(1);
    const theirs = [sessions.create(person.id), sessions.create(person.id)];
    sessions.remove(mine);
    expect(sessions.memberId(mine)).toBeNull();
    sessions.removeAllFor(person.id);
    expect(theirs.map((t) => sessions.memberId(t))).toEqual([null, null]);
  });
  it('stops counting a session when its person is removed, and never counts one for an agent', () => {
    const db = openDb(':memory:');
    const sessions = new Sessions(db, () => new Date());
    const members = new Members(db, () => new Date());
    const person = members.createPerson('Sarah').member;
    const theirs = sessions.create(person.id);
    expect(sessions.memberId(theirs)).toBe(person.id);
    members.removePerson(person.id, members.owner());
    expect(sessions.memberId(theirs)).toBeNull();
    expect(sessions.memberId(sessions.create(members.createAgent('Muse').member.id))).toBeNull();
  });
  it('writes and reads the cookie', () => {
    expect(sessionCookie('abc')).toBe('gc_session=abc; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000');
    expect(clearedSessionCookie()).toBe('gc_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    expect(readCookie('a=1; gc_session=xyz; b=2', 'gc_session')).toBe('xyz');
    expect(readCookie(undefined, 'gc_session')).toBeUndefined();
    expect(readCookie('gc_sessionx=1', 'gc_session')).toBeUndefined();
  });
});
