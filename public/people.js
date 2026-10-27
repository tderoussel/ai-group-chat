import { api } from './api.js';
import { activePeople, agentStatus, avatarEl, budgetLine, connectedLine, el, keyFromCard, myName, personStatus, setMembers, wakeLine } from './lib.js';

let members = [];
let wakeById = new Map();
/** The id of the agent or person whose options are showing, kept across the 5-second refresh. */
let open = null;

/** Loads the members and wake links, then draws the Agents screen (agents and people) and the chat's top bar. */
export async function loadPeople() {
  const [{ members: latest, budgetLeft }, { wakes }] = await Promise.all([api('GET', '/api/members'), api('GET', '/api/wakes')]);
  members = latest;
  wakeById = new Map(wakes.map((w) => [w.memberId, w]));
  setMembers(members);
  document.getElementById('budget').textContent = budgetLine(budgetLeft, activePeople(members).length);
  draw();
}

function draw() {
  const agents = members.filter((m) => m.kind === 'agent');
  document.getElementById('agent-summary').textContent = connectedLine(members);
  document.getElementById('avatar-stack').replaceChildren(...agents.filter((m) => !m.revoked).slice(0, 4).map((m) => avatarEl(m.name)));
  document.getElementById('member-list').replaceChildren(...agents.map((m) => memberRow(m, wakeById.get(m.id))));
  document.getElementById('people-list').replaceChildren(...members.filter((m) => m.kind !== 'agent').map(personRow));
}

/** One agent: avatar, name and status. Tapping it shows or hides its options. */
function memberRow(m, wake) {
  const li = el('li');
  const head = el('button', 'member');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open === m.id));
  const text = el('span', 'member-text');
  text.append(el('span', 'member-name', m.name), el('span', 'member-status', agentStatus(m)));
  const wakeText = wakeLine(wake);
  if (wakeText) text.append(el('span', 'member-wake', wakeText));
  head.append(avatarEl(m.name), text);
  head.onclick = () => {
    open = open === m.id ? null : m.id;
    draw();
  };
  li.append(head);
  if (open === m.id) li.append(memberOptions(m, wake));
  return li;
}

function memberOptions(m, wake) {
  const box = el('div', 'member-options');
  box.append(action('New link', '', async () => {
    const ask = m.revoked
      ? `Bring ${m.name} back with a new link? Only the new link will work.`
      : `Give ${m.name} a new link? Its current link stops working right away.`;
    if (!confirm(ask)) return;
    await showCard(m.name, (await api('POST', `/api/agents/${m.id}/rotate`)).joinCard);
  }));
  box.append(action(wake?.configured ? 'Change wake link' : 'Wake link', '', () => editWakeLink(m)));
  if (wake?.configured) {
    box.append(action('Remove wake link', '', async () => {
      if (!confirm(`Remove ${m.name}'s wake link? You'll need its address and key again to restore it.`)) return;
      await api('POST', `/api/agents/${m.id}/wake/clear`);
      await loadPeople();
    }));
  }
  if (!m.revoked) {
    box.append(action('Cut off', 'danger', async () => {
      if (!confirm(`Cut ${m.name} off? Its link stops working right away.`)) return;
      await api('POST', `/api/agents/${m.id}/revoke`);
      await loadPeople();
    }));
  }
  return box;
}

/** One person: avatar, name and status. Tapping someone else who was added shows their options; the owner has none. */
function personRow(m) {
  const li = el('li');
  const manageable = m.kind === 'person' && m.name !== myName();
  const head = el(manageable ? 'button' : 'div', 'member');
  if (manageable) {
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open === m.id));
    head.onclick = () => {
      open = open === m.id ? null : m.id;
      draw();
    };
  }
  const text = el('span', 'member-text');
  text.append(el('span', 'member-name', m.name), el('span', 'member-status', personStatus(m)));
  head.append(avatarEl(m.name), text);
  li.append(head);
  if (manageable && open === m.id) li.append(personOptions(m));
  return li;
}

function personOptions(m) {
  const box = el('div', 'member-options');
  box.append(action('New invite link', '', async () => {
    const ask = m.revoked
      ? `Bring ${m.name} back with a new invite link? They pick a new password when they use it.`
      : m.joined
        ? `Give ${m.name} a new invite link? When they use it, they pick a new password and are signed out everywhere else.`
        : `Give ${m.name} a new invite link? The old one stops working right away.`;
    if (!confirm(ask)) return;
    await showInviteLink(m.name, (await api('POST', `/api/people/${m.id}/invite`)).inviteLink);
  }));
  if (!m.revoked) {
    box.append(action('Remove', 'danger', async () => {
      if (!confirm(`Remove ${m.name}? They are signed out right away and agents stop taking their instructions. Their messages stay. Agent links they saw keep working until you give those agents new links.`)) return;
      await api('POST', `/api/people/${m.id}/remove`);
      await loadPeople();
    }));
  }
  return box;
}

/** True while an option is working: one at a time, so two quick taps can't leave a panel showing a link already replaced. */
let acting = false;

function action(label, className, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  b.onclick = () => {
    if (acting) return;
    acting = true;
    onClick().catch((e) => alert(e.message)).finally(() => { acting = false; });
  };
  return b;
}

/** Saves the address and key of an agent's webhook or API trigger. The key is stored encrypted and never shown again. */
async function editWakeLink(m) {
  const url = prompt(`${m.name}'s wake address: the https address of its routine's webhook or API trigger (a Claude scheduled task calls it the Fire URL).`);
  if (!url) return;
  const key = prompt(`${m.name}'s wake key (a Claude scheduled task calls it the token). It is stored encrypted and never shown again.`);
  if (!key) return;
  await api('POST', `/api/agents/${m.id}/wake`, { url, key });
  await loadPeople();
}

/** Opens the join card panel. The card is shown only this once, so the panel stays until Done. */
async function showCard(name, text) {
  document.getElementById('join-title').textContent = `Join card for ${name}`;
  document.getElementById('join-card-text').textContent = text;
  const card = document.getElementById('join-card');
  card.hidden = false;
  try { await loadPeople(); } finally { card.scrollIntoView({ block: 'nearest' }); }
}

/** Opens the invite link panel. The link is shown only this once, so the panel stays until Done. */
async function showInviteLink(name, link) {
  document.getElementById('invite-title').textContent = `Invite link for ${name}`;
  document.getElementById('invite-link-text').textContent = link;
  const panel = document.getElementById('invite-panel');
  panel.hidden = false;
  try { await loadPeople(); } finally { panel.scrollIntoView({ block: 'nearest' }); }
}

export function wirePeople() {
  const input = document.getElementById('agent-name');
  document.getElementById('add-agent').onsubmit = async (event) => {
    event.preventDefault();
    try {
      const r = await api('POST', '/api/agents', { name: input.value });
      input.value = '';
      await showCard(r.member.name, r.joinCard);
    } catch (e) {
      alert(e.message);
    }
  };
  document.getElementById('close-card').onclick = () => { document.getElementById('join-card').hidden = true; document.getElementById('join-card-text').textContent = ''; };
  const card = () => document.getElementById('join-card-text').textContent;
  copyButton('copy-card', card);
  copyButton('copy-key', () => keyFromCard(card()));
  const personInput = document.getElementById('person-name');
  document.getElementById('add-person').onsubmit = async (event) => {
    event.preventDefault();
    try {
      const r = await api('POST', '/api/people', { name: personInput.value });
      personInput.value = '';
      await showInviteLink(r.member.name, r.inviteLink);
    } catch (e) {
      alert(e.message);
    }
  };
  document.getElementById('close-invite').onclick = () => { document.getElementById('invite-panel').hidden = true; document.getElementById('invite-link-text').textContent = ''; };
  copyButton('copy-invite', () => document.getElementById('invite-link-text').textContent);
}

/** Copies on tap and says so on the button for two seconds. If the browser won't copy, shows the text to copy by hand. */
function copyButton(id, text) {
  const b = document.getElementById(id);
  const label = b.textContent;
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text());
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Copy failed';
      prompt('Copy this yourself:', text());
    }
    setTimeout(() => { b.textContent = label; }, 2000);
  };
}
