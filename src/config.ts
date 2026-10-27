export type Config = {
  port: number;
  dataDir: string;
  /** The app's public origin (APP_ORIGIN, or Render's RENDER_EXTERNAL_URL when that is unset), e.g. https://your-chat.onrender.com, with no trailing slash. */
  appOrigin: string;
  appName: string;
  /** The owner's name in the chat (OWNER_NAME). Agents take the owner's instructions. */
  ownerName: string;
  /** The time zone whose calendar day the daily agent limit counts (TIME_ZONE), e.g. America/New_York. */
  timeZone: string;
  /** The owner's password: it signs the owner in, whatever the Name box holds. */
  setupCode: string;
  /** Seals the outside secrets the app keeps (wake keys, events signing secrets). Null turns those features off. */
  dataKey: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const fail = (message: string): never => { throw new Error(`config: ${message}`); };

  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT must be a port number');

  const appOrigin = (env.APP_ORIGIN || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  let url: URL | null = null;
  try { url = new URL(appOrigin); } catch { fail('APP_ORIGIN must be a full URL such as https://your-chat.onrender.com'); }
  const parsed = url as URL;
  if (parsed.origin !== appOrigin) fail('APP_ORIGIN must be an origin only (scheme, host and optional port), with no path');
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !local) fail('APP_ORIGIN must use https (http is allowed only for localhost)');

  const ownerName = (env.OWNER_NAME ?? 'Owner').trim() || 'Owner';
  if (!/^[A-Za-z0-9_]{1,24}$/.test(ownerName) || ownerName.toLowerCase() === 'everyone') {
    fail('OWNER_NAME must be 1 to 24 letters, digits or underscores, and not "everyone"');
  }

  const timeZone = (env.TIME_ZONE ?? 'UTC').trim() || 'UTC';
  try { new Intl.DateTimeFormat('en-CA', { timeZone }); } catch { fail('TIME_ZONE must be an IANA time zone such as America/New_York or Europe/London'); }

  const setupCode = env.SETUP_CODE ?? '';
  if (setupCode.length < 12) fail('SETUP_CODE must be at least 12 characters');

  const dataKey = env.DATA_KEY ?? '';
  if (dataKey && dataKey.length < 20) fail('DATA_KEY must be at least 20 characters');

  return {
    port,
    dataDir: env.DATA_DIR ?? './data',
    appOrigin,
    appName: (env.APP_NAME ?? 'Group Chat').slice(0, 40),
    ownerName,
    timeZone,
    setupCode,
    dataKey: dataKey || null,
  };
}
