import type { IncomingMessage, ServerResponse } from 'node:http';

export class BodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Reads a JSON request body of at most `max` bytes. An empty body reads as null.
 * An oversized body is refused from its Content-Length before reading, or read to the end and
 * dropped, so the 413 reply reaches the client instead of a connection reset.
 */
export async function readJsonBody(req: IncomingMessage, max: number): Promise<unknown> {
  const tooBig = () => new BodyError(`The request body is larger than ${max} bytes.`, 413);
  if (Number(req.headers['content-length'] ?? 0) > max) throw tooBig();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size <= max) chunks.push(buf);
  }
  if (size > max) throw tooBig();
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError('The request body is not valid JSON.', 400);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Hides agent keys in anything that gets logged: everything after /mcp or /mcp-events (the rest of the path, the
 * query and any #), since an app may send a whole link, or a key in the query, where the key belongs. Linear time
 * (see the adversarial test).
 */
export function redactUrl(url: string): string {
  return url.replace(/\/mcp(-events)?[/?#]\S*/g, '/mcp$1/[key]');
}
