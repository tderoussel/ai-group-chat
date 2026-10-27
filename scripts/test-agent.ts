import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Connects through the door the way an AI would: lists the tools, reads what's new and, if given text, posts it. */
export async function runTestAgent(connectorUrl: string, text?: string): Promise<{ tools: string[]; read: unknown; posted: unknown }> {
  const client = new Client({ name: 'group-chat-test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(connectorUrl)));
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const read = parse(await client.callTool({ name: 'read_new_messages', arguments: {} }));
    const posted = text ? parse(await client.callTool({ name: 'post_message', arguments: { text } })) : null;
    return { tools, read, posted };
  } finally {
    await client.close();
  }
}

function parse(result: unknown): unknown {
  const r = result as { content: { text?: string }[]; isError?: boolean };
  const text = r.content[0]?.text ?? '';
  if (r.isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [url, ...words] = process.argv.slice(2);
  if (!url) {
    console.error('Usage: npm run test-agent -- <connector link> [message to post]');
    process.exit(2);
  }
  runTestAgent(url, words.join(' ') || undefined)
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
