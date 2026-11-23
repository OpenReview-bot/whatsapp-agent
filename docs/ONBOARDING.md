# Onboarding guide

This guide takes a new operator from a clean checkout to a running agent. It describes what the code on `main` does. Where something has not been proven against live WhatsApp or Meta, it says so.

## 1. Before you start

- Bun 1.3.0 or later.
- A model credential: either `GEMINI_API_KEY`, or the Google Cloud CLI signed in (`gcloud auth login`) with a project set.
- A WhatsApp number to link. Pick one transport (section 4):
  - `baileys` (default): links a personal or business account as a companion device. Unofficial; the account can be restricted by WhatsApp.
  - `meta-cloud`: the official WhatsApp Business Cloud API. Needs a Meta business account, an app and a phone number ID.
- Optional: PostgreSQL for the learning store. Chats, drafts and capabilities stay in SQLite either way. See [PostgreSQL migration](POSTGRES_MIGRATION.md).

## 2. Install and check

```bash
bun install
bun run build
cp .env.example .env     # then edit; leave unknown values empty
bun run cli doctor
```

`doctor` on `main` checks the Bun runtime, whether a Google credential is reachable, and that local storage opens. A pass does not prove the model, WhatsApp or Meta settings are correct. It does not check your transport.

## 3. Minimum configuration

| Setting | Why |
|---|---|
| `GEMINI_API_KEY`, or a signed-in `gcloud` with `GOOGLE_CLOUD_PROJECT` | The model needs credentials. |
| `HOST` and `AGENT_DASHBOARD_TOKEN` | The cockpit binds `127.0.0.1` by default. If you set another `HOST`, startup refuses to run unless the token is at least 24 characters. |
| `AGENT_ALLOWED_ORIGINS` | Only when the cockpit sits behind a reverse proxy. |
| `AGENT_AUTOPILOT_BRAND_ID` | Names the tenant for memory isolation. Needed for Meta mode. |

Leave `DATABASE_URL` empty unless you want the PostgreSQL learning store.

Note: `.env.example` lists `DATA_DIR` and `GOOGLE_CLOUD_LOCATION`. The runtime entry point does not read them. State goes to `./data`. Do not rely on either setting.

## 4. Link WhatsApp

### Baileys (default)

```bash
bun run dev                 # starts the server and the agent
```

Open `http://localhost:3000`. The pairing dialog shows a QR code. In WhatsApp, open Linked devices and scan it. To use an 8-digit pairing code instead, run `bun run cli pair <phone>` and enter the code shown in the terminal.

The session is stored under `./data`. Back that directory up like a credential.

### Meta Cloud API

```bash
export WHATSAPP_TRANSPORT=meta-cloud
export META_CLOUD_GRAPH_VERSION=...      # for example v23.0
export META_CLOUD_PHONE_NUMBER_ID=...
export META_CLOUD_BUSINESS_ACCOUNT_ID=...
export META_CLOUD_ACCESS_TOKEN=...
export META_CLOUD_APP_SECRET=...
export META_CLOUD_VERIFY_TOKEN=...       # a random string you also enter in Meta
export AGENT_AUTOPILOT_BRAND_ID=...
bun run start
```

In the Meta app dashboard, set the webhook callback to `https://<your-public-host>/webhooks/meta` and the verify token to the same value. Meta calls this route without your dashboard cookie, so the route is public by design: GET is checked with the verify token and POST with an HMAC of the raw body. Your proxy must pass the body and the `X-Hub-Signature-256` header through unchanged. Details: [webhook routes](meta-cloud-webhook-routes.md) and [API adapter](meta-cloud-api-adapter.md).

Free-form text is blocked until the customer has sent an inbound message. This is tested with a fake Graph API only. No real Meta account has been used to verify it.

## 5. Choose a mode before real customers write in

Each chat has a mode: `autopilot`, `copilot` or `human`. **The default for a new chat is `autopilot`, which replies on its own.** If you want review first, set `copilot` before linking a number that receives live traffic.

Set a chat's mode in the cockpit, or:

```bash
curl -X POST http://localhost:3000/api/chats/<chatId>/mode \
  -H 'content-type: application/json' -d '{"mode":"copilot"}'
```

(Add your dashboard token if one is set.) In `copilot`, replies appear as drafts. Approve with `POST /api/drafts/:draftId/approve` or the cockpit, or reject with `POST /api/drafts/:draftId/reject`. In `human`, the agent only watches.

## 6. Dry run without sending

```bash
bun run cli simulate "السلام عليكم، هو الكورس متاح حالياً وبكام؟"
```

This runs the moderator decision on a test message and prints the action, intent, confidence and proposed reply. It sends nothing to WhatsApp. It calls the model, so it needs the credential from section 3, and it may record the test message in local storage.

## 7. Connect an AI assistant (optional)

`bun run mcp` starts the stdio MCP server. Register it as shown in the [README](../README.md#mcp-server-integration). Treat its send tools as live send tools once WhatsApp is linked.

## 8. Day-two checks

- `GET /api/status` shows the connection state. `GET /api/diagnostics` shows runtime details.
- `bun test` runs the backend suite. `cd ui && bun run build` builds the cockpit.
- `bun run security:audit` scans dependency lockfiles.

## 9. What is not proven here

- Delivery over a real WhatsApp account, a real Meta number, or a real PostgreSQL service has not been exercised by the tests in this repository.
- The PostgreSQL cutover of chats, drafts and capabilities is not complete. Only the learning store moves.
