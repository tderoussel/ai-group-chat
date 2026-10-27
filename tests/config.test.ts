import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const good = { APP_ORIGIN: 'https://your-chat.onrender.com', SETUP_CODE: 'x'.repeat(24) };

/** The message loadConfig fails with for this environment. */
const messageFor = (env: NodeJS.ProcessEnv): string => {
  try { loadConfig(env); } catch (e) { return (e as Error).message; }
  return 'loadConfig did not throw';
};

describe('loadConfig', () => {
  it('reads a valid environment and fills in the defaults', () => {
    expect(loadConfig(good)).toEqual({
      port: 3000, dataDir: './data', appOrigin: 'https://your-chat.onrender.com',
      appName: 'Group Chat', ownerName: 'Owner', timeZone: 'UTC', setupCode: 'x'.repeat(24), dataKey: null,
    });
  });
  it('strips a trailing slash from APP_ORIGIN', () => {
    expect(loadConfig({ ...good, APP_ORIGIN: 'https://your-chat.onrender.com/' }).appOrigin).toBe('https://your-chat.onrender.com');
  });
  it('allows http only for localhost', () => {
    expect(loadConfig({ ...good, APP_ORIGIN: 'http://localhost:3000' }).appOrigin).toBe('http://localhost:3000');
    expect(() => loadConfig({ ...good, APP_ORIGIN: 'http://example.com' })).toThrow(/https/);
  });
  it('rejects a missing APP_ORIGIN or one with a path', () => {
    expect(() => loadConfig({ SETUP_CODE: good.SETUP_CODE })).toThrow(/APP_ORIGIN/);
    expect(() => loadConfig({ ...good, APP_ORIGIN: 'https://x.onrender.com/chat' })).toThrow(/origin only/);
  });
  it("falls back to Render's RENDER_EXTERNAL_URL when APP_ORIGIN is unset or empty, and APP_ORIGIN wins when both are set", () => {
    const onRender = { SETUP_CODE: good.SETUP_CODE, RENDER_EXTERNAL_URL: 'https://my-chat.onrender.com/' };
    expect(loadConfig(onRender).appOrigin).toBe('https://my-chat.onrender.com');
    expect(loadConfig({ ...onRender, APP_ORIGIN: '' }).appOrigin).toBe('https://my-chat.onrender.com');
    expect(loadConfig({ ...onRender, APP_ORIGIN: 'https://chat.example.com' }).appOrigin).toBe('https://chat.example.com');
  });
  it('checks an address that came from RENDER_EXTERNAL_URL like any APP_ORIGIN', () => {
    expect(messageFor({ SETUP_CODE: good.SETUP_CODE, RENDER_EXTERNAL_URL: 'http://my-chat.onrender.com' }))
      .toBe('config: APP_ORIGIN must use https (http is allowed only for localhost)');
    expect(messageFor({ SETUP_CODE: good.SETUP_CODE, RENDER_EXTERNAL_URL: 'https://my-chat.onrender.com/chat' }))
      .toBe('config: APP_ORIGIN must be an origin only (scheme, host and optional port), with no path');
  });
  it('fails with the APP_ORIGIN error when neither APP_ORIGIN nor RENDER_EXTERNAL_URL is set', () => {
    const expected = 'config: APP_ORIGIN must be a full URL such as https://your-chat.onrender.com';
    expect(messageFor({ SETUP_CODE: good.SETUP_CODE })).toBe(expected);
    expect(messageFor({ SETUP_CODE: good.SETUP_CODE, APP_ORIGIN: '', RENDER_EXTERNAL_URL: '' })).toBe(expected);
  });
  it('rejects a short SETUP_CODE', () => {
    expect(() => loadConfig({ ...good, SETUP_CODE: 'short' })).toThrow(/SETUP_CODE/);
  });
  it('takes a SETUP_CODE of 12 characters, which the owner may set as their password, but not 11', () => {
    expect(loadConfig({ ...good, SETUP_CODE: 'x'.repeat(12) }).setupCode).toBe('x'.repeat(12));
    expect(() => loadConfig({ ...good, SETUP_CODE: 'x'.repeat(11) })).toThrow(/at least 12 characters/);
  });
  it('reads OWNER_NAME: Owner when unset or empty, the trimmed name otherwise', () => {
    expect(loadConfig(good).ownerName).toBe('Owner');
    expect(loadConfig({ ...good, OWNER_NAME: '' }).ownerName).toBe('Owner');
    expect(loadConfig({ ...good, OWNER_NAME: '   ' }).ownerName).toBe('Owner');
    expect(loadConfig({ ...good, OWNER_NAME: '  Alex  ' }).ownerName).toBe('Alex');
    expect(loadConfig({ ...good, OWNER_NAME: 'a_1' }).ownerName).toBe('a_1');
    expect(loadConfig({ ...good, OWNER_NAME: 'x'.repeat(24) }).ownerName).toBe('x'.repeat(24));
  });
  it('rejects an OWNER_NAME with a space, over 24 characters, or "everyone" in any case, with one exact message', () => {
    const expected = 'config: OWNER_NAME must be 1 to 24 letters, digits or underscores, and not "everyone"';
    for (const bad of ['Alex Smith', 'x'.repeat(25), 'Everyone', 'everyone', ' EVERYONE ', 'a-b', 'Zoë']) {
      expect(messageFor({ ...good, OWNER_NAME: bad }), JSON.stringify(bad)).toBe(expected);
    }
  });
  it('reads TIME_ZONE: UTC when unset or empty, the trimmed name otherwise', () => {
    expect(loadConfig(good).timeZone).toBe('UTC');
    expect(loadConfig({ ...good, TIME_ZONE: '' }).timeZone).toBe('UTC');
    expect(loadConfig({ ...good, TIME_ZONE: '   ' }).timeZone).toBe('UTC');
    expect(loadConfig({ ...good, TIME_ZONE: ' Europe/London ' }).timeZone).toBe('Europe/London');
    expect(loadConfig({ ...good, TIME_ZONE: 'America/New_York' }).timeZone).toBe('America/New_York');
  });
  it('rejects a TIME_ZONE that is not an IANA time zone, with one exact message', () => {
    const expected = 'config: TIME_ZONE must be an IANA time zone such as America/New_York or Europe/London';
    for (const bad of ['Mars/Olympus', 'not a zone', 'Europe/Londn']) {
      expect(messageFor({ ...good, TIME_ZONE: bad }), bad).toBe(expected);
    }
  });
  it('reads DATA_KEY, which must be at least 20 characters when set', () => {
    expect(loadConfig({ ...good, DATA_KEY: 'k'.repeat(32) }).dataKey).toBe('k'.repeat(32));
    expect(() => loadConfig({ ...good, DATA_KEY: 'short' })).toThrow(/DATA_KEY/);
  });
  it('validates PORT', () => {
    expect(loadConfig({ ...good, PORT: '10000' }).port).toBe(10000);
    expect(() => loadConfig({ ...good, PORT: 'abc' })).toThrow(/PORT/);
  });
});
