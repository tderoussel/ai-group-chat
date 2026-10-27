import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { hashSecret } from '../src/keys.js';
import { INVITE_GONE, isOwner, MemberError, Members } from '../src/members.js';

let db: Db;
let now: Date;
let members: Members;
beforeEach(() => { db = openDb(':memory:'); now = new Date('2026-10-23T12:00:00Z'); members = new Members(db, () => now); });

describe('Members', () => {
  it('creates an agent, returns its key once and stores only a hash', () => {
    const { member, key } = members.createAgent('Muse');
    expect(member).toMatchObject({ name: 'Muse', kind: 'agent', revoked: false, readPosition: 0, lastCheckInAt: null });
    const row = db.prepare('SELECT key_hash FROM members WHERE id = ?').get(member.id) as { key_hash: string };
    expect(row.key_hash).not.toBe(key);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(members.agentByKey(key)?.name).toBe('Muse');
    expect(members.agentByKey('not-a-real-key-at-all-0000000')).toBeNull();
  });
  it('rejects bad, reserved and duplicate names', () => {
    expect(() => members.createAgent('two words')).toThrow(MemberError);
    expect(() => members.createAgent('')).toThrow(MemberError);
    expect(() => members.createAgent('x'.repeat(25))).toThrow(MemberError);
    expect(() => members.createAgent('Everyone')).toThrow(/reserved/);
    expect(() => members.createAgent('owner')).toThrow(/already/);
    members.createAgent('Duet');
    expect(() => members.createAgent('duet')).toThrow(/already/);
  });
  it('rotating a key retires the old one', () => {
    const { member, key } = members.createAgent('Dots');
    const fresh = members.rotateKey(member.id);
    expect(members.agentByKey(key)).toBeNull();
    expect(members.agentByKey(fresh)?.id).toBe(member.id);
  });
  it('revoking cuts the agent off until it gets a new key', () => {
    const { member, key } = members.createAgent('Grokbot');
    members.revoke(member.id);
    expect(members.agentByKey(key)).toBeNull();
    expect(members.byId(member.id)?.revoked).toBe(true);
    const again = members.rotateKey(member.id);
    expect(members.agentByKey(again)?.revoked).toBe(false);
  });
  it('lists the owner first and finds members by name, ignoring case', () => {
    members.createAgent('Muse');
    expect(members.list().map((m) => m.name)).toEqual(['Owner', 'Muse']);
    expect(members.byName('muse')?.name).toBe('Muse');
    expect(members.owner()).toMatchObject({ id: 1, name: 'Owner', kind: 'owner' });
    expect(() => members.rotateKey(1)).toThrow(MemberError);
  });
  it('adds a person with an invite that lasts 7 days, storing only its hash', () => {
    const { member, token } = members.createPerson('Sarah');
    expect(member).toMatchObject({ name: 'Sarah', kind: 'person', joined: false, revoked: false, inviteExpiresAt: '2026-10-30T12:00:00.000Z' });
    expect(db.prepare('SELECT invite_hash, password_hash FROM members WHERE id = ?').get(member.id)).toEqual({ invite_hash: hashSecret(token), password_hash: null });
    expect(members.personByInvite(token)?.id).toBe(member.id);
    expect(members.personByInvite('not-a-real-invite-token-000000000000000000')).toBeNull();
    expect(members.ownerNames()).toEqual(['Owner']);
    now = new Date('2026-10-30T12:00:01Z');
    expect(members.personByInvite(token)).toBeNull();
    expect(() => members.createPerson('sarah')).toThrow(/already/);
    expect(() => members.createPerson('Owner')).toThrow(/already/);
    expect(() => members.createPerson('two words')).toThrow(MemberError);
  });
  it('an invite sets the password once; the person then signs in by name, ignoring case', async () => {
    const { member, token } = members.createPerson('Sarah');
    await expect(members.acceptInvite(token, 'short')).rejects.toThrow(/at least 12/);
    expect(await members.acceptInvite(token, 'first password here')).toMatchObject({ joining: true, member: { id: member.id, joined: true, inviteExpiresAt: null } });
    await expect(members.acceptInvite(token, 'first password here')).rejects.toThrow(INVITE_GONE);
    expect((await members.personByPassword('sarah', 'first password here'))?.id).toBe(member.id);
    expect(await members.personByPassword('Sarah', 'the wrong password')).toBeNull();
    expect(await members.personByPassword('Nobody', 'first password here')).toBeNull();
    expect(await members.personByPassword('Owner', 'first password here')).toBeNull();
    expect(members.ownerNames()).toEqual(['Owner', 'Sarah']);
  });
  it('refuses an invite that runs out while the password is being hashed', async () => {
    const { token } = members.createPerson('Sarah');
    now = new Date('2026-10-30T11:59:59.999Z');
    const accepting = members.acceptInvite(token, 'a long enough password');
    now = new Date('2026-10-30T12:00:00.001Z');
    await expect(accepting).rejects.toThrow(INVITE_GONE);
    expect(members.byName('Sarah')).toMatchObject({ joined: false });
  });
  it('lets only the first of two tries with one invite through', async () => {
    const { token } = members.createPerson('Sarah');
    const tries = await Promise.allSettled([members.acceptInvite(token, 'first password here'), members.acceptInvite(token, 'second password here')]);
    expect(tries.map((t) => t.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
  it('a new invite replaces the old link and keeps the password until it is used', async () => {
    const { member, token } = members.createPerson('Sarah');
    await members.acceptInvite(token, 'first password here');
    const fresh = members.newInvite(member.id);
    expect(members.personByInvite(token)).toBeNull();
    expect((await members.personByPassword('Sarah', 'first password here'))?.id).toBe(member.id);
    expect(await members.acceptInvite(fresh, 'second password here')).toMatchObject({ joining: false });
    expect(await members.personByPassword('Sarah', 'first password here')).toBeNull();
    expect(() => members.newInvite(1)).toThrow(/no such person/);
  });
  it('removing a person stops their password and link; a new invite brings them back', async () => {
    const owner = members.owner();
    const { member, token } = members.createPerson('Sarah');
    await members.acceptInvite(token, 'first password here');
    expect(() => members.removePerson(member.id, member)).toThrow(/yourself/);
    expect(() => members.removePerson(1, member)).toThrow(/no such person/);
    expect(members.removePerson(member.id, owner)).toMatchObject({ revoked: true, joined: false, inviteExpiresAt: null });
    expect(() => members.removePerson(member.id, owner)).toThrow(/already removed/);
    expect(await members.personByPassword('Sarah', 'first password here')).toBeNull();
    expect(members.ownerNames()).toEqual(['Owner']);
    const back = members.newInvite(member.id);
    expect(await members.acceptInvite(back, 'second password here')).toMatchObject({ joining: true, member: { revoked: false, joined: true } });
    expect(members.ownerNames()).toEqual(['Owner', 'Sarah']);
  });
  it('counts the owner and people who were not removed as owners, never agents', () => {
    const agent = members.createAgent('Muse').member;
    const person = members.createPerson('Sarah').member;
    expect([members.owner(), person, agent].map(isOwner)).toEqual([true, true, false]);
    expect(isOwner(members.removePerson(person.id, members.owner()))).toBe(false);
    expect(members.owner()).toMatchObject({ joined: true, inviteExpiresAt: null });
  });
});

describe('renameOwner', () => {
  const errorOf = (fn: () => void): unknown => {
    try { fn(); } catch (e) { return e; }
    return undefined;
  };
  it('renames member 1: owner() and ownerNames() show the new name, and the kind stays owner', () => {
    members.renameOwner('Alex');
    expect(members.owner()).toMatchObject({ id: 1, name: 'Alex', kind: 'owner', joined: true });
    expect(members.ownerNames()[0]).toBe('Alex');
    expect(members.list().map((m) => m.name)).toEqual(['Alex']);
    expect(db.prepare('SELECT id, name, kind FROM members').all()).toEqual([{ id: 1, name: 'Alex', kind: 'owner' }]);
  });
  it('rejects a name that breaks the rule, with the same message a new member gets', () => {
    for (const bad of ['bad name', '', 'x'.repeat(25), 'a-b']) {
      const e = errorOf(() => members.renameOwner(bad));
      expect(e, JSON.stringify(bad)).toBeInstanceOf(MemberError);
      expect((e as Error).message, JSON.stringify(bad)).toBe('Names are 1 to 24 letters, digits or underscores.');
    }
    expect(members.owner().name).toBe('Owner');
  });
  it('rejects "everyone" in any case', () => {
    for (const bad of ['EVERYONE', 'everyone', 'Everyone']) expect(errorOf(() => members.renameOwner(bad)), bad).toBeInstanceOf(MemberError);
    expect(members.owner().name).toBe('Owner');
  });
  it('rejects the name of another member in any case, agent or person, and changes nothing', () => {
    members.createAgent('Muse');
    members.createPerson('Sarah');
    const e = errorOf(() => members.renameOwner('muse'));
    expect(e).toBeInstanceOf(MemberError);
    expect((e as Error).message).toBe('"muse" is already the name of another member.');
    expect((errorOf(() => members.renameOwner('SARAH')) as Error).message).toBe('"SARAH" is already the name of another member.');
    expect(members.owner().name).toBe('Owner');
    expect(members.list().map((m) => m.name)).toEqual(['Owner', 'Muse', 'Sarah']);
  });
  it('allows the current name, also in another case', () => {
    members.renameOwner('Owner');
    members.renameOwner('OWNER');
    expect(members.owner().name).toBe('OWNER');
    members.renameOwner('Alex');
    members.renameOwner('alex');
    expect(members.owner().name).toBe('alex');
  });
  it('protects the new name like any other member name, and frees the old one', () => {
    members.renameOwner('Alex');
    expect(() => members.createAgent('alex')).toThrow(/already/);
    expect(() => members.createPerson('ALEX')).toThrow(/already/);
    expect(members.createAgent('Owner').member.name).toBe('Owner');
  });
});
