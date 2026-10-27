/** Calls the chat's API. Throws an Error carrying the server's message (and `status`) on failure. */
export async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') headers['x-group-chat'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status}).`);
    error.status = res.status;
    throw error;
  }
  return data;
}
