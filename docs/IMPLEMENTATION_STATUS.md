# Implementation status at main 9e93c1f (refreshed 2026-11-22)

This is a source-code inventory for `main` at commit `9e93c1f`. It replaces the 2026-11-08 baseline (`0e1c19b`), which predated the S01 ledger, Meta Cloud transport, S07 identity, A05 inbound planner, A08 scheduler and WCF work. It is **not** a release sign-off or evidence of a connected WhatsApp account, successful delivery, live model accuracy, or production database cutover.

**Status definitions**

- **Implemented slice**: corresponding code and automated tests exist; live behavior may still need proof
- **Partial**: a useful subset exists but the published capability's end-to-end contract is incomplete
- **Planned**: the named contract is documented without a corresponding integrated implementation at this baseline

For the desired product contract, read [the capability blueprint](plans/whatsapp-agent-service-specs-2026-11-06/README.md). Its implementation phases and E2E scenarios are acceptance criteria, **not** results from passing tests. The individual service appendices describe future work unless linked to an implementation below.

## Agent capabilities A01–A10

| Capability | Baseline status | Source-code evidence and boundary |
| --- | --- | --- |
| A01 Brand Brain | **Partial** | Versioned text/FAQ/CSV ingestion, retrieval, source-conflict checks and a UI exist in [brand-knowledge](../src/agent/brand-knowledge.ts), [capability routes](../src/agent/capabilities-api.ts), and [BrandBrainPage](../ui/src/components/BrandBrainPage.tsx). Website crawling, broad catalog sync, and source-review workflows are not complete |
| A02 Hybrid retrieval | **Partial** | SQLite FTS5 and optional embedding-provider scoring exist in [brand-knowledge](../src/agent/brand-knowledge.ts). [createCapabilities](../src/agent/capabilities-api.ts) does not supply an embedding provider, so the normal runtime path is lexical search |
| A03 Web Scout | **Implemented slice** | [WebScout](../src/agent/web-scout.ts) requests Google Search grounding, filters source URLs and handles insufficient evidence; [web-scout tests](../tests/web-scout.test.ts) cover the contract. Live provider correctness remains unverified here |
| A04 Multimodal inbox | **Partial** | [document extraction](../src/agent/media-service.ts), [Python worker](../workers/media-python/document_worker.py), and [audio handling](../src/ai/audio-transcriber.ts) exist. The complete image/OCR-to-verified-business-action scenario is not implemented end to end |
| A05 Autonomous planner | **Partial** | [BoundedPlanner](../src/agent/bounded-planner.ts) runs a scoped, journaled tool loop. [InboundPlanner](../src/agent/inbound-planner.ts) routes eligible inbound turns through it only when `AGENT_PLANNER_INBOUND=1` (default scopes `inventory:read`, writes off); otherwise the moderator path runs. Tests: [bounded-planner](../tests/bounded-planner.test.ts), [inbound-planner](../tests/inbound-planner.test.ts), [composition](../tests/inbound-planner-composition.test.ts). Write tools with verified provider receipts are not implemented |
| A06 Business connectors | **Partial** | [Google Sheets inventory](../src/agent/sheets-inventory.ts) and a [registration endpoint](../src/agent/capabilities-api.ts) are available. No full production Shopify, order, CRM, calendar, or ticket connector suite is evidenced |
| A07 Customer 360 | **Partial** | [CustomerContextStore](../src/agent/customer-context.ts) records brand-scoped facts and cases, alongside existing chat memory. Conversation folding ([WCF](../src/domain/context-fold-engine.ts), [design](plans/2026-11-06-whatsapp-context-fold.md)) is implemented for the moderator prompt; cross-conversation customer retrieval remains proposed |
| A08 Proactive engagement | **Partial** | [FollowUpStore](../src/agent/follow-ups.ts) and [ProactiveEngagementScheduler](../src/agent/proactive-scheduler.ts) persist schedules and opt-outs and send approved templates through the S01 ledger, in Meta Cloud mode only. The host must inject a trusted `proactiveEligibility` provider; none ships by default, so nothing sends proactively out of the box. Tests: [follow-ups](../tests/follow-ups.test.ts), [proactive-scheduler](../tests/proactive-scheduler.test.ts), [runtime composition](../tests/proactive-runtime-composition.test.ts). No evidence of a run against a live Meta account |
| A09 Specialist skills | **Planned** | The [A09 service spec](plans/whatsapp-agent-service-specs-2026-11-06/agentic-services/A09-specialist-skills.md) defines sales, service, booking and quote workflows; no complete provider-backed skill pack is identified |
| A10 Quality loop | **Partial** | [QualityLoop](../src/agent/quality-loop.ts) stores scenario outcomes and aggregates scores and knowledge gaps. This is not the versioned offline reply-evaluation lab, blind/human model review, or an independently validated quality grade |

## Supporting services S01–S08

| Service | Baseline status | Source-code evidence and boundary |
| --- | --- | --- |
| S01 Reliable delivery | **Implemented slice** | [SendIntentService](../src/domain/send-intent-service.ts) and [send ledger](../src/domain/send-ledger.ts) persist intents and attempts before transport (queued, attempting, accepted, delivered, read, uncertain, failed) and do not auto-retry an uncertain send. Used by auto replies, manual sends, draft approval and MCP. Tests: [send-intents](../tests/send-intents.test.ts), [template/identity bridge](../tests/send-template-identity-bridge.test.ts). Live delivery and receipt reconciliation against a real account remain unproven |
| S02 Permission/privacy gate | **Partial** | [permission-engine](../src/domain/permission-engine.ts) and [permission tests](../tests/permission-engine.test.ts) cover deterministic actions. End-to-end tenant/privacy governance requires further verification |
| S03 Memory recall | **Partial** | [Message memory](../src/domain/memory-store.ts), [learning memory](../src/domain/learning-memory.ts), Brand Brain retrieval and hierarchical conversation folds ([WCF](../src/domain/context-fold-engine.ts), [tests](../tests/context-fold.test.ts)) exist; a consolidated evidence-linked recall service is not complete |
| S04 Media intelligence | **Partial** | [document media service](../src/agent/media-service.ts) and [media tests](../tests/document-extraction.test.ts) cover bounded extraction, with gaps in the full cross-modal workflow |
| S05 Reply Evaluation Lab | **Partial** | [Evaluation lab](../src/evaluation-lab/README.md) replays recorded fixtures through the real moderator and permission path with an in-memory database and no network. The checked-in reference has no human approval, so the demo run exits 2 with `review_required`.. Test: [reply-evaluation-lab](../tests/reply-evaluation-lab.test.ts) |
| S06 Commitments/follow-ups | **Partial** | [FollowUpStore](../src/agent/follow-ups.ts) has persistent triggers and safety checks, but no evidence of autonomous delivery through the production messaging path |
| S07 Identity reconciliation | **Implemented slice** | [ContactIdentityDirectory](../src/identity/contact-directory.ts) keeps per-brand contact IDs and immutable aliases, with default-deny evidence verification; opened in Meta Cloud mode and checked before dispatch ([README](../src/identity/README.md)). Test: [contact-identity](../tests/contact-identity.test.ts). No evidence verifier is installed by default |
| S08 Health/diagnostics | **Partial** | [diagnostics-core](../src/observability/diagnostics-core.ts) backs `/api/diagnostics` (persisted send-ledger counts plus in-process traces), alongside [SSE](../src/server/sse.ts) and `/api/status`. Inbound-path logs are metadata-only with hashed chat IDs ([safe-log](../src/observability/safe-log.ts)). No metrics export, tracing backend or alerting. Tests: [diagnostics-core](../tests/diagnostics-core.test.ts), [diagnostics-integration](../tests/diagnostics-integration.test.ts), [privacy-logging](../tests/privacy-logging.test.ts) |

## Transports and tooling

| Area | Status | Evidence and boundary |
| --- | --- | --- |
| Baileys socket (default) | **Implemented slice** | [whatsapp-socket](../src/transport/whatsapp-socket.ts), patched at install by [patch-baileys.mjs](../patch-baileys.mjs). Unofficial client, so account-policy risk applies; live behavior unproven here |
| Meta Cloud API | **Implemented slice, no live proof** | [meta-cloud-api](../src/transport/meta-cloud-api.ts) and [webhook routes](../src/server/meta-cloud-routes.ts), selected with `WHATSAPP_TRANSPORT=meta-cloud` ([activation guide](B2_RUNTIME_ACTIVATION.md)). Tested with fake fetch and signed fixtures only. Text and approved text templates only |
| Standalone MCP runner | **Implemented slice** | [mcp/cli](../src/mcp/cli.ts) starts a [managed channel](../src/mcp/managed-channel.ts) and binds the 12 tools to it; [runtime tests](../tests/mcp-runtime.test.ts) cover composition with a fake transport. Stdio only; no HTTP MCP endpoint. Live socket start is not exercised in tests |
| `cli doctor` | **Implemented slice** | [doctor](../src/doctor.ts) separates install preflight from live readiness and exits 1 on any failure ([tests](../tests/doctor.test.ts)). It checks configuration, not a live connection |

## Persistence: schema versus runtime

The repository includes [PostgreSQL schema migrations and SQLite import tooling](../src/persistence/postgres/) for application tables. That proves the migration **path** exists, not that every live writer uses PostgreSQL.

At this baseline:

- [src/index.ts](../src/index.ts) constructs the main `MemoryStore` against SQLite and [src/agent/capabilities-api.ts](../src/agent/capabilities-api.ts) creates separate SQLite capability stores
- A configured `DATABASE_URL` makes [PostgresLearningStore](../src/persistence/postgres/learning-store.ts) available specifically to the learning-memory and reflection path
- The remaining chat, draft, workflow, brand-source, follow-up, and evaluation writers have not been switched to PostgreSQL in the runtime shown here
- Live migration, database cutover, tenant isolation, backup/restore, and real WhatsApp delivery still need an independently verified pilot

See [PostgreSQL migration guide](POSTGRES_MIGRATION.md) for an offline export/import procedure and rollback limits. Do not treat import success as a green light to resume SQLite writers or to assume PostgreSQL is the active store.

## Evidence and release gates

| Test group | Corresponding files/commands | What passing tests can show |
| --- | --- | --- |
| Backend | `bun test`, [tests](../tests/) | Module, API and synthetic integration behavior; most provider flows are mocked |
| UI | `cd ui && bun test:ui`, `cd ui && bun run build` | Component SSR, static build and type-check; not a complete browser accessibility audit |
| Media | `python -m unittest` or project worker test invocation, [worker tests](../workers/media-python/test_worker.py) | Document parser behavior with available dependencies |
| Database | `bun test tests/pg-migration.test.ts` | Migration and importer contract on isolated test data; no production cutover |
| Security | `bun run security:audit` | Advisory scanner result only if invocation succeeds and yields valid output; this audit wrapper needs fail-closed handling at baseline |

Local verification on 2026-11-22 from a clean clone of `main` 9e93c1f with Bun 1.4.5 (`bun install` in the root and in `ui/`): `bun test` reported **449 pass, 3 skip, 0 fail** across 66 files. The skipped cases are configuration-dependent live checks. `ui` tests need `cd ui && bun install` first, otherwise two SSR test files fail to resolve `react`. This run does not establish a live database, WhatsApp, Meta or model connection.

**Pending proof before a product launch:** connected-channel delivery and receipt reconciliation, true mixed-mode and approval concurrency, live connector mutation receipts, provider credential/permission review, verified PostgreSQL runtime cutover, recovery, privacy/retention tests, and Arabic/English realistic customer E2E scenarios

When in-flight feature PRs are merged, update this inventory against the new `main` SHA and attach test/CI evidence. A PR opening alone does not change the status here
