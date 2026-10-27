import { api } from './api.js';

/** Sign-in with a name and password; the owner may leave the name empty. Calls onSignedIn() once it works. `message` says why the page is here. */
export function showLogin(onSignedIn, message = '') {
  const section = document.getElementById('login');
  const name = document.getElementById('login-user');
  const input = document.getElementById('setup-code');
  const error = document.getElementById('login-error');
  section.hidden = false;
  error.textContent = message;
  // One try at a time: a double tap would sign in twice and start the app twice.
  let busy = false;
  document.getElementById('setup-form').onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error.textContent = '';
    try {
      await api('POST', '/api/setup-login', { name: name.value, code: input.value });
      input.value = '';
      section.hidden = true;
      onSignedIn();
    } catch (e) {
      error.textContent = e.message;
    } finally {
      busy = false;
    }
  };
}

/** The page an invite link opens: the person picks a password and joins. A dead link goes to sign-in with the reason. */
export async function showInvite(token, onSignedIn) {
  const toSignIn = (message) => {
    history.replaceState(null, '', '/');
    showLogin(onSignedIn, message);
  };
  let name;
  try {
    ({ name } = await api('POST', '/api/invite/check', { token }));
  } catch (e) {
    // Only a dead link goes to sign-in. Anything else (too many tries, no connection) keeps the link, so reloading tries again.
    if (e.status === 400) return toSignIn(e.message);
    throw e;
  }
  const section = document.getElementById('invite');
  const password = document.getElementById('invite-password');
  const again = document.getElementById('invite-again');
  const error = document.getElementById('invite-error');
  document.getElementById('invite-welcome').textContent = `Welcome, ${name}. Pick a password to join.`;
  // The name sits in a read-only field so the phone saves it with the new password.
  document.getElementById('invite-user').value = name;
  section.hidden = false;
  let busy = false;
  document.getElementById('invite-form').onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    error.textContent = '';
    if (password.value !== again.value) {
      error.textContent = "The two passwords don't match.";
      return;
    }
    busy = true;
    try {
      await api('POST', '/api/invite/accept', { token, password: password.value });
      password.value = '';
      again.value = '';
      section.hidden = true;
      history.replaceState(null, '', '/');
      onSignedIn();
    } catch (e) {
      error.textContent = e.message;
    } finally {
      busy = false;
    }
  };
}
