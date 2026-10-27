import { api } from './api.js';
import { avatarEl, cardLabel, colorFor, dayLabel, el, membersKey, mergeMessages, myName, requestParts } from './lib.js';

let messages = [];
let drawn = '';

export async function loadThread() {
  const { messages: latest } = await api('GET', '/api/messages');
  addMessages(latest);
}

/**
 * Merges messages in and redraws only when something changed: a new message, a decided card, or newly known members'
 * colors. Keeps the reader's place: it jumps to the newest message only if they were near the bottom, or `jump` is set.
 */
export function addMessages(incoming, jump = false) {
  messages = mergeMessages(messages, incoming);
  const key = `${membersKey()}|${messages.map((m) => `${m.id}:${m.status ?? ''}`).join(',')}`;
  if (key === drawn && !jump) return;
  drawn = key;
  const thread = document.getElementById('thread');
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  const items = [];
  let lastDay = '';
  for (const m of messages) {
    const day = dayLabel(m.at);
    if (day !== lastDay) items.push(el('li', 'day', day));
    lastDay = day;
    items.push(renderMessage(m));
  }
  thread.replaceChildren(...items);
  if (nearBottom || jump) thread.scrollTop = thread.scrollHeight;
}

function renderMessage(m) {
  if (m.kind === 'system') return el('li', 'system', m.text);
  const mine = m.from === myName();
  const li = el('li', `msg ${mine ? 'mine' : 'theirs'}`);
  li.dataset.color = colorFor(m.from);
  if (!mine) li.append(avatarEl(m.from));
  const body = el('div', 'body');
  if (!mine) body.append(el('div', 'who', m.from));
  body.append(m.kind === 'request' ? requestCard(m) : el('div', 'bubble', m.text));
  body.append(el('div', 'time', new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
  li.append(body);
  return li;
}

/** A request card: who asks, the action, and Approve and Decline while it's pending. */
function requestCard(m) {
  const { askedBy, action } = requestParts(m.text);
  const card = el('div', 'card');
  card.append(el('div', 'card-head', `${m.from} asks for your OK${askedBy ? ` for ${askedBy}` : ''}`), el('div', 'card-action', action));
  if (m.status === 'pending') {
    const buttons = el('div', 'card-buttons');
    buttons.append(decideButton(m.id, 'approved', 'Approve', 'primary'), decideButton(m.id, 'declined', 'Decline', ''));
    card.append(buttons);
  } else {
    card.append(el('div', `card-status ${m.status}`, cardLabel(m.status, m.decided_by)));
  }
  return card;
}

function decideButton(id, decision, label, className) {
  const b = el('button', className, label);
  b.type = 'button';
  b.onclick = async () => {
    const error = document.getElementById('chat-error');
    const buttons = [...b.parentElement.querySelectorAll('button')];
    error.textContent = '';
    buttons.forEach((x) => { x.disabled = true; });
    try {
      await api('POST', `/api/requests/${id}/decide`, { decision });
      // The newest 100 messages may not include an older card, so fetch the page that ends with it and merge only that card, which keeps the reader's place.
      addMessages((await api('GET', `/api/messages?before=${id + 1}`)).messages.filter((m) => m.id === id));
      await loadThread();
    } catch (e) {
      error.textContent = e.message;
      buttons.forEach((x) => { x.disabled = false; });
    }
  };
  return b;
}

/** The message box: grows with the text up to five lines, ignores a second Send while one is posting, and jumps to the newest message after sending. */
export function wireComposer() {
  const box = document.getElementById('message');
  const error = document.getElementById('chat-error');
  let sending = false;
  const grow = () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 120)}px`;
  };
  box.oninput = grow;
  document.getElementById('composer').onsubmit = async (event) => {
    event.preventDefault();
    if (sending) return;
    sending = true;
    error.textContent = '';
    try {
      addMessages([await api('POST', '/api/messages', { text: box.value })], true);
      box.value = '';
      grow();
    } catch (e) {
      error.textContent = e.message;
    } finally {
      sending = false;
    }
  };
}
