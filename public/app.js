import { api } from './api.js';
import { setMe } from './lib.js';
import { showInvite, showLogin } from './login.js';
import { loadPeople, wirePeople } from './people.js';
import { loadThread, wireComposer } from './thread.js';
import { startUpdates } from './updates.js';

/** Shows an error in the line at the top of the page, which is visible whether or not anyone is signed in. */
function showError(e) {
  document.getElementById('page-error').textContent = `${e.message} Reload the page to try again.`;
}

/** Whether the thread was at the newest message when the reader left the chat. It is measured while the chat is still visible, because a hidden thread reports zero sizes. */
let stickToBottom = true;

/** Shows the chat or the Agents screen. Updates keep running behind either one. Coming back to the chat re-pins the newest message if the reader was there, and resizes the message box. */
function showScreen(name) {
  const thread = document.getElementById('thread');
  if (name !== 'chat' && !document.getElementById('chat').hidden) stickToBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  document.getElementById('chat').hidden = name !== 'chat';
  document.getElementById('agents').hidden = name !== 'agents';
  if (name === 'chat') {
    if (stickToBottom) thread.scrollTop = thread.scrollHeight;
    document.getElementById('message').dispatchEvent(new Event('input'));
  }
}

async function start() {
  const me = await api('GET', '/api/me');
  document.title = me.appName;
  document.getElementById('app-name').textContent = me.appName;
  document.getElementById('login-name').textContent = me.appName;
  document.getElementById('invite-heading').textContent = `Join ${me.appName}`;
  // An invite link opens the invite page for someone signed out. Someone signed in (the owner checking a link they just
  // made, say) stays in the chat, and the link stays unused.
  // Not anchored at the end: a link pasted with a trailing "." or ")" still works. The server checks the token itself.
  const invite = /^#invite=([A-Za-z0-9_-]{20,200})/.exec(location.hash)?.[1];
  if (invite && !me.signedIn) return showInvite(invite, () => start().catch(showError));
  if (invite) history.replaceState(null, '', '/');
  if (!me.signedIn) return showLogin(() => start().catch(showError));
  setMe(me.me);
  showScreen('chat');
  document.getElementById('open-agents').onclick = () => showScreen('agents');
  document.getElementById('close-agents').onclick = () => showScreen('chat');
  document.getElementById('sign-out').onclick = () => { api('POST', '/api/logout').then(() => location.reload(), showError); };
  wireComposer();
  wirePeople();
  // Polling starts first, so a failed first load still recovers on the next refresh.
  startUpdates();
  // People first: the member list sets each agent's color before the thread is drawn. A failed people load still draws the thread.
  try { await loadPeople(); } finally { await loadThread(); }
}

// An invite link opened in a tab that already shows the page only changes the part after #, which doesn't reload it.
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#invite=')) location.reload(); });
start().catch(showError);
