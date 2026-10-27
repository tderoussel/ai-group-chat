import { createServer } from 'node:http';
import { Chat } from './chat.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { EventsDoor, eventsDoorRoute, eventsOnTag } from './events-door.js';
import { Members } from './members.js';
import { RateLimiter } from './ratelimit.js';
import { Sessions } from './sessions.js';
import { Settings } from './settings.js';
import { Wakes, wakeOnTag, wakeRoutes } from './wake.js';
import { createApp, type ExtraRoute } from './web.js';

const VERSION = '0.1.0';
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const config = loadConfig(process.env);
const db = openDb(config.dataDir, log);
const clock = systemClock;
const members = new Members(db, clock);
try {
  members.renameOwner(config.ownerName);
} catch (e) {
  log(`config: OWNER_NAME: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const settings = new Settings(db);
const chat = new Chat(db, members, settings, clock, config.timeZone);
const sessions = new Sessions(db, clock);
const doorLimiter = new RateLimiter(60, 60_000);
const wakes = new Wakes(db, members, clock, config.dataKey);
const eventsDoor = new EventsDoor(db, chat, clock, config.dataKey);
wakeOnTag(chat, wakes, log);
eventsOnTag(chat, eventsDoor, log);
if (!config.dataKey) log('wake links and the ChatGPT events door are off: DATA_KEY is not set');
const extraRoutes: ExtraRoute[] = [
  wakeRoutes(wakes),
  eventsDoorRoute(eventsDoor, { appOrigin: config.appOrigin, members, limiter: doorLimiter }),
];

const server = createServer(createApp({
  config, members, chat, settings, sessions, version: VERSION, log, extraRoutes, doorLimiter,
  loginLimiter: new RateLimiter(10, 60_000),
  nameLimiter: new RateLimiter(20, 3_600_000),
}));
server.listen(config.port, '0.0.0.0', () => log(`listening on port ${config.port} for ${config.appOrigin}`));

function shutdown(): void {
  log('shutting down');
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
