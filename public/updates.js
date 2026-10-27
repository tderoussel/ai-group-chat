import { loadPeople } from './people.js';
import { loadThread } from './thread.js';

/** Refreshes every 5 seconds while the page is visible. An expired session reloads the page, which shows the sign-in. */
export function startUpdates() {
  const onError = (e) => { if (e.status === 401) location.reload(); };
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    loadThread().catch(onError);
    loadPeople().catch(onError);
  }, 5000);
}
