# Endpoint inventory, permissions and environment

Audit #46, Phase 3. Derived from `src/server/api.ts`, `src/server/dashboard-auth.ts`, `src/agent/capabilities-api.ts`, `src/server/meta-cloud-routes.ts`, `src/funnel/registry.ts` and `.env.example`. Read from code, not exercised live.

## Three separate credentials

| Credential | Sent as | Guards |
| --- | --- | --- |
| Dashboard owner token `AGENT_DASHBOARD_TOKEN` | `Authorization: Bearer` or the `wa_owner_session` cookie (12 h, HttpOnly, SameSite=Strict, `Secure` off loopback) | Every `/api/*` route except the prefixes below. If unset, dashboard auth is off. A non-loopback `HOST` requires a token of 24+ characters. |
| Capability owner token `AGENT_CAPABILITIES_OWNER_TOKEN` | `x-agent-owner-token` | `/api/brands/*` and `/api/agent/*`. These prefixes are exempt from dashboard auth and use this token instead. Unset means 503 (fail closed). |
| Funnel API key `FUNNEL_API_KEY` (falls back to `AGENT_CAPABILITY_TOKEN`) | `Authorization: Bearer` or `x-api-key` | Funnel methods registration, dispatch and circuit-breaker reset. No key configured means every call is rejected. |

Meta webhooks use Meta's own scheme (verify token for GET, HMAC with the app secret for POST). The GitHub webhook uses `x-hub-signature-256`.

Browser mutations from a foreign `Origin` are rejected with 403 unless the origin is trusted. Callers with no `Origin` header (curl, services) pass this check, which is why the server binds to loopback by default.

## Endpoints

Auth column: D = dashboard token, C = capability owner token, F = funnel key, S = signature, N = none.

| Area | Routes | Auth |
| --- | --- | --- |
| Session | `GET /api/auth/status`, `POST/DELETE /api/auth/session` | N (these establish auth) |
| Status | `GET /api/status`, `/api/diagnostics`, `/api/db/health`, `/api/agent/status`* | D (`/api/agent/status` is C) |
| Connection | `POST /api/connect`, `/api/disconnect` (Baileys pairing; 409 in Meta mode) | D |
| Chats | `GET /api/chats`, `/api/chats/:id/messages`, `/api/chats/:id/folds`; `POST .../messages`, `/mode`, `/reaction`, `/fold-now` | D |
| Drafts | `GET /api/drafts`; `POST /api/drafts/:id/approve`, `/reject` | D |
| Delivery | `POST /api/send-intents/:id/retry` | D |
| Contacts | `/api/contacts/:jid/memories`, `/api/contacts/:chatId/dossier` (+ `/facts`, `/commitments`), `/api/chats/:jid/style` | D |
| Persona and learning | `GET/PUT /api/persona`, `/api/learning/state`, `PUT /api/learning/rules`, `POST /api/learning/reflect`, `/compact` | D |
| Media, simulation | `POST /api/media/sticker`, `/api/simulate` | D |
| Live events | `GET /api/events` (SSE) | D |
| Brand knowledge and customers | `/api/brands/:brandId/...` sources, documents/ingest, retrieve, web/search, evaluations, tools, quality, conflicts, followups, connectors/google-sheets, customers (context, facts, cases, optout) | C |
| Planner | `POST /api/agent/plan`, `/api/agent/resolve` | C |
| Funnel | `GET /api/funnel/methods`, `/api/funnel/stats` | N (read) |
| Funnel | `POST /api/funnel/methods`, `/dispatch`, `/circuit-breaker/reset` | F |
| Webhooks | `POST /api/webhooks/github` | S |
| Meta Cloud | `GET/POST /webhooks/meta` | Meta verify token / HMAC |
| Static UI | `GET *` | N |

### Review notes (not changed in this PR)

1. `GET /api/funnel/methods` and `/api/funnel/stats` are unauthenticated even when a dashboard token is set, because `/api/funnel/` is exempt. They list dispatch targets and URLs. A test already asserts the exemption. Decide whether read access should need the funnel key or the dashboard token.
2. Three credentials is a lot for an owner to manage. The README should say which one to set for which feature. Setting only `AGENT_DASHBOARD_TOKEN` leaves `/api/brands/*` and `/api/agent/*` returning 503.
3. Dashboard sessions are in memory, so a restart signs everyone out. Acceptable for a single-owner tool.

## Environment variables (all names the code reads)

| Group | Variables |
| --- | --- |
| Server | `PORT`, `HOST`, `DATA_DIR`, `WHATSAPP_TRANSPORT` (baileys default, meta-cloud) |
| Access | `AGENT_DASHBOARD_TOKEN`, `AGENT_CAPABILITIES_OWNER_TOKEN`, `AGENT_CAPABILITY_TOKEN`, `FUNNEL_API_KEY`, `AGENT_ALLOWED_ORIGINS` |
| Models | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `GEMINI_FOLD_MODEL`, `GEMINI_REFLECTION_MODEL`, `GEMINI_TRANSCRIBE_MODEL`, `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` |
| Router | `JEV_ROUTER_ENABLED`, `JEV_EXTERNAL_ROUTING_ALLOWED`, `JEV_CONFIDENCE_THRESHOLD`, `JEV_ROUTER_TIMEOUT_MS` |
| Planner | `AGENT_PLANNER_ALLOW_WRITES`, `AGENT_PLANNER_ALLOWED_SCOPES`, `AGENT_PLANNER_BRAND_ID`, `AGENT_PLANNER_INBOUND`, `AGENT_PLANNER_MAX_STEPS`, `AGENT_AUTOPILOT_BRAND_ID`, `AGENT_CAPABILITIES_AUTOPILOT` |
| Meta Cloud | `META_CLOUD_ACCESS_TOKEN`, `META_CLOUD_APP_SECRET`, `META_CLOUD_VERIFY_TOKEN`, `META_CLOUD_PHONE_NUMBER_ID`, `META_CLOUD_BUSINESS_ACCOUNT_ID`, `META_CLOUD_GRAPH_VERSION` |
| Postgres / Supabase | `DATASTORE` (postgres fails closed), `DATABASE_URL`, `DATABASE_TRANSACTION_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` |
| Features | `CONTEXT_FOLD_ENABLED`, `AGENT_MEDIA_PYTHON` |
| GitHub review app | `GITHUB_APP_WEBHOOK_SECRET` (the other `GITHUB_APP_*` and `SOURCERY_TOKEN` values are in `.env.example`) |

Secrets: `GEMINI_API_KEY`, `TYPESAFE_API_KEY`, all tokens and keys above, `META_CLOUD_ACCESS_TOKEN`, `META_CLOUD_APP_SECRET`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`. Keep them out of logs and screenshots.

## Measured memory

Started with `bun run src/index.ts` on Bun 1.4.5, Linux, unpaired (QR ready), no traffic: **about 96 MiB resident (VmRSS 98,044 kB)** after 14 s. The README's earlier "~80 MB" claim was not backed by a measurement, so it now states this number. A paired session under message load was not measured and will be higher.
