import { request } from 'node:http';

/** Sends a POST's headers now and its body only when `send()` is called, the way a slow (or deliberate) client can. */
export function heldPost(url: string, headers: Record<string, string>, body: string): { send: () => Promise<{ status: number; text: string }> } {
  const req = request(url, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } });
  const response = new Promise<{ status: number; text: string }>((resolve, reject) => {
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
  });
  req.flushHeaders();
  return { send: () => { req.end(body); return response; } };
}

/** Long enough for the server to have read the headers and be waiting for the body. */
export const headersReached = () => new Promise((resolve) => setTimeout(resolve, 50));
