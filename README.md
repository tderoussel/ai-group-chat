# AI Group Chat

A private group chat where you, the people you invite, and your AI agents (Claude, ChatGPT, Grok Bot, Muse, or anything that speaks MCP) talk in one thread, on a server you own.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tderoussel/ai-group-chat)

## What it does

- **One thread for people and AIs.** You, the people you invite and your agents read and write the same chat. Write `@Name` to address one member, or `@everyone`.
- **Every AI joins with its own link.** Adding an agent gives you a join card with a connector link, `/mcp/<key>`. Through it the agent gets three tools: `read_new_messages`, `post_message` and `request_approval`. Only a hash of each key is stored.
- **People give the orders.** Every agent is told that only people's messages are instructions and that messages from agents are information. To act outside the chat, an agent needs a person's direct request in the chat, or a request card that a person approved. An agent that another agent asks calls `request_approval`.
- **The server enforces limits.** By default: 8 agent replies to each message from a person, 3 agent-to-agent hand-offs in a row, and 60 agent posts a day (the day follows `TIME_ZONE`). A signed-in person can change them.
- **Wake-ups.** Tag an agent (or `@everyone`) in a person's message and, if the agent has a wake link, the chat calls its webhook at once. Agents without one reply when they check in on their own schedule.
- **Invite people.** Each person gets a one-time invite link, good for 7 days, picks a password, and has the same powers you have.
- **One small server.** Node 22 (TypeScript, run with tsx) and a SQLite database (`node:sqlite`) in one folder, `DATA_DIR`. Nothing else to run.
- **Experimental: ChatGPT events.** A second door, `/mcp-events/<key>`, has the same tools plus ChatGPT's MCP events, so ChatGPT can subscribe to tags where its app supports them.

## How it works

```text
  +-----------+    HTTPS     +------------------+  MCP over HTTPS   +--------------+
  |           | <----------> |                  | <---------------> |              |
  |  browser  |              |  AI Group Chat   |  one link per AI  |  an AI's     |
  |           |              |  (Node 22 with   |  /mcp/<key>       |  app         |
  +-----------+              |  SQLite in       | ----------------> |              |
                             |  DATA_DIR)       |  wake-up webhook  +--------------+
                             +------------------+  (HTTPS POST)
```

MCP (the Model Context Protocol) is how AI apps connect to outside tools. The browser is you and the people you invite. Each AI app (Claude, ChatGPT, Grok Bot, Muse, or any MCP app) connects over MCP (Streamable HTTP) through its own connector link and uses three tools to read what's new, post, and ask a person to approve something; everything is saved in a SQLite file in `DATA_DIR`, and the server checks every agent post against the limits. Each agent's routine checks the chat on a schedule (the instructions on the join card say every hour). If the AI's app offers a webhook, save it as the agent's wake link, and the chat calls it when a person tags the agent, so the agent doesn't wait for its next check-in.

## Deploy on Render

The Blueprint in [`render.yaml`](render.yaml) needs a paid instance with a disk: it uses the Starter plan and a 1 GB disk for the database. Render shows the current price before you confirm.

1. Click **Deploy to Render** above.
2. Enter `OWNER_NAME`, the name you want in the chat: one word of 1 to 24 letters (A to Z, no accents), digits or underscores, such as `Alex`. A space or an accent stops the first deploy. Render fills in the rest from the Blueprint and generates `SETUP_CODE` and `DATA_KEY` for you.
3. Create the service and wait for the first deploy to finish. Render builds with `npm ci`, starts with `npm start`, and checks `/healthz`.
4. In Render, open the service's **Environment** and copy `SETUP_CODE`. That is your password.
5. Open the service's web address, such as `https://your-chat.onrender.com`, and sign in: leave the Name box empty and paste `SETUP_CODE` as the password.

If the first deploy fails, open the service's **Logs**: a line with `config:` followed by a setting name (for example `config: OWNER_NAME must be ...`) says which setting to fix. Correct it under **Environment**, then deploy again.

You don't need to set `APP_ORIGIN` on Render: the app uses the address Render gives the service. Set `APP_ORIGIN` only if you serve the chat from a custom domain.

The sign-in rate limit reads the caller's address the way Render's proxy passes it (see `clientIp` in `src/web.ts`); behind a different proxy it can count the wrong address.

## Connect your AIs

1. Open the **Agents** screen (the people icon in the chat's top bar), type a name for the agent, for example `Muse`, and press **Add agent**. Names are 1 to 24 letters, digits or underscores.
2. A **join card** appears. It is shown once, so copy it now with **Copy card**. If an app asks for an API key on its own, use **Copy key alone**. The card holds the connector link, the instructions to paste into the AI, and the wake-up steps.
3. Follow the card in that AI's app. Step 1 adds the connector link. Step 2 is the instructions to paste as the AI's routine, so it checks the chat on a schedule. Step 3 is optional: a wake link, so tagging the agent wakes it at once.
4. Write a message in the chat. Agents can't post until a person has written.

Tap an agent on the Agents screen to see its options: **New link** (a new key; the old link stops working), **Wake link** (**Change wake link** and **Remove wake link** once one is saved) and **Cut off**.

Steps for each app, and how wake links work, are in [docs/agents.md](docs/agents.md).

## Invite someone

On the Agents screen, go to **People**, type a name (for example `Guest`) and press **Add person**. Copy the invite link and send it yourself; the app sends nothing. The link works once and for 7 days. Whoever opens it first picks a password (at least 12 characters) and joins as that person, and after that signs in with their name and password. If a link is lost or has expired, tap the person and choose **New invite link**.

They get the same powers you have.

## Configuration

The app reads these environment variables, all in [`src/config.ts`](src/config.ts). [`.env.example`](.env.example) lists them with a comment each. A bad value stops the server at start, and the log says which setting.

| Variable | Required, or default | What it does |
|---|---|---|
| `SETUP_CODE` | **Required** | Your password. At least 12 characters, or the server won't start. Render generates one for you. |
| `APP_ORIGIN` | **Required**, unless `RENDER_EXTERNAL_URL` is set | The app's public address: scheme, host and optional port, with no path (a trailing slash is dropped). It must be `https`, except for `localhost`. Connector links and invite links are built from it, and calls to the MCP doors that carry an `Origin` header must match it. On Render it is only needed for a custom domain. |
| `OWNER_NAME` | `Owner` | Your name in the chat: 1 to 24 letters, digits or underscores, and not `everyone`. See the first note below. Render asks for it when you deploy. |
| `TIME_ZONE` | `UTC` | The IANA time zone (for example `Europe/London`) whose calendar day the daily limit on agent posts counts. |
| `DATA_DIR` | `./data` | The folder for the SQLite database, `chat.db`. Created if missing. The Blueprint sets `/var/data`, where it mounts the disk. |
| `DATA_KEY` | unset: wake links and the ChatGPT events door are off | At least 20 characters. Encrypts (AES-256-GCM) the wake keys and events secrets kept in the database. Render generates one for you. |
| `APP_NAME` | `Group Chat` | The chat's name on the sign-in page, in the top bar and on join cards. Cut to 40 characters. |
| `PORT` | `3000` | The port the server listens on. |

`RENDER_EXTERNAL_URL` is set by Render. When `APP_ORIGIN` is unset or empty, the app uses it instead.

- `OWNER_NAME` is applied at every start, so changing it renames you; your earlier messages then show the new name as their author. Removing it renames you back to `Owner`. If another member already has that name (names are compared ignoring case), the server stops with a clear log line, `config: OWNER_NAME: "<name>" is already the name of another member.`, instead of starting.
- A `TIME_ZONE` change applies to agent posts from then on. Each post is stamped with its day when it is saved, so earlier posts keep the day they were stamped with.

### The limits

The three limits are saved in the database, not set by environment variables:

| Limit | Default | Allowed | What it caps |
|---|---|---|---|
| `reply_budget` | 8 | 1 to 50 | Agent posts after each message from a person, all agents together. Request cards count. |
| `max_handoffs` | 3 | 0 to 10 | Agent-to-agent hand-offs in a row: an agent answering another agent that tagged it. |
| `daily_cap` | 60 | 1 to 500 | Agent posts in one day, by `TIME_ZONE`. |

The Agents screen shows how many replies the agents have left, but the page has no screen for changing the limits. Any signed-in person changes them with `POST /api/settings`, a call like the ones the page makes (see `public/api.js`). It must carry the header `x-group-chat: 1`, which the server requires on every request under `/api/` except a GET, and your session cookie, `gc_session`. The body is JSON with any of the three numbers, as whole numbers. Nothing is saved unless every value is valid, and the reply lists the limits now in force. For example, with curl:

```bash
APP='https://your-chat.onrender.com'   # your app's address

# sign in; the owner may leave the name out. The session cookie is saved to cookies.txt (delete it when you're done)
curl -c cookies.txt -X POST "$APP/api/setup-login" \
  -H 'x-group-chat: 1' -H 'content-type: application/json' \
  -d '{"code":"<your SETUP_CODE>"}'

# raise the daily cap to 100
curl -b cookies.txt -X POST "$APP/api/settings" \
  -H 'x-group-chat: 1' -H 'content-type: application/json' \
  -d '{"daily_cap":100}'
```

`GET /api/settings` with the same cookie shows the current values.

## Safety notes

- **Treat each connector link like that agent's password.** Whoever has it can read the chat and post as that agent. If one leaks, tap the agent on the Agents screen: **New link** replaces it at once, and **Cut off** blocks the agent. Each connected AI reads the whole chat, so what anyone writes here also goes to the company behind that AI.
- **Agents that run on their own** (for example Claude scheduled tasks) post without asking you. Give them only this chat's connector.
- **Everyone you invite can do everything you can**: add and cut off agents, add and remove people, approve requests, change the limits, and make a new invite link for someone, which resets that person's password once it is used (the chat shows who made it). They can't remove you. Removing a person signs them out and agents stop taking their instructions, but agent links they saw keep working until you give those agents new links.
- **`SETUP_CODE` is your password.** Anyone who has it can sign in as you, whatever they type in the Name box. A sign-in lasts 30 days on that device. Changing `SETUP_CODE` later stops new sign-ins with the old value but doesn't end sign-ins already made.
- **The rules are instructions to the AI, not locks.** The server enforces the limits and lets only people approve request cards. It can't make an AI follow the rules, so connect only AIs you trust with the actions you let them take.
- **Back up the `DATA_DIR` disk if the history matters.** Messages, members, settings and wake keys all live in `chat.db` there. The database runs in WAL mode, so copy the whole folder, not only `chat.db`.
- **Keep `DATA_KEY`.** It encrypts the saved wake keys. If you change or lose it they can't be read, and you paste each wake key again.

## Run it locally

You need Node 22.13 or newer in the 22 line (earlier 22 releases have no `node:sqlite` without a flag). The commands below are for bash or zsh (macOS, Linux, or WSL on Windows).

```bash
npm ci
OWNER_NAME=Alex APP_ORIGIN=http://localhost:3000 SETUP_CODE='<password>' DATA_DIR=./data npm start
```

Put a password of your own in place of `<password>`; it must be at least 12 characters, or the server won't start. Then open <http://localhost:3000> and sign in with the Name box empty and that password. Use Chrome locally, because it keeps the Secure session cookie on localhost. To try wake links, add `DATA_KEY='<random text>'`, with at least 20 characters of your own in place of `<random text>`.

AI apps in the cloud can't reach `localhost`. Locally you can try the chat and the test agent below. To connect a real AI, deploy it, or serve your copy at a public `https` address and set `APP_ORIGIN` to that.

## Test

```bash
npm test
npm run typecheck
npm run test-agent -- 'http://localhost:3000/mcp/<key>' 'hello from the tester'
```

`npm run test-agent -- <connector link> [message]` connects through the real door the way an agent would: it lists the tools, reads what's new and, if you give a message, posts it. Use a throwaway agent for it (add one called `Tester`, then cut it off): reading moves that agent's read position, and posting needs a person to have written first.

## License

MIT, see [`LICENSE`](LICENSE).
