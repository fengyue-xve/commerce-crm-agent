# Core module map

This map separates the upstream CRM platform from the fulfillment verification
extension used in this portfolio. Paths are intentionally concrete so a reviewer
can follow a claim from the README to the implementation and its tests.

## Upstream foundation

| Area | Representative modules | Role in the platform |
| --- | --- | --- |
| Web application | `app/`, `components/`, `hooks/`, `proxy.ts` | Next.js application shell, tenant workspaces, channel UI and request boundary |
| Tenant data and auth | `supabase/`, `lib/supabase/`, `lib/auth/`, `lib/api/` | Postgres schema, RLS, session and role guards, API response contracts |
| Agent runtime | `lib/agent-engine/`, `lib/agent-runtime/`, `lib/ai/` | Pi runtime integration, model gateway, memory, RAG and MCP surfaces |
| Operations | `workers/`, `scripts/`, `docker-compose*.yml` | event workers, scheduled jobs, self-hosting and verification commands |
| License and notices | `LICENSE` and source headers retained from upstream | MIT terms and original copyright remain part of every distribution |

## Independently implemented or extended portfolio modules

| Module | Files | Implementation responsibility | Resume highlight |
| --- | --- | --- | --- |
| Multi-step fulfillment Agent | `lib/ai/fulfillment/agent.ts`, `agent-config.ts` | Pi tool loop with Faux replay and OpenAI/DeepSeek-compatible providers; observations become structured facts and proposed actions | Real/Faux dual engine and multi-step Tool Calling |
| Evidence boundary | `lib/ai/fulfillment/evidence.ts` | Zod strict schema, organization/SKU scope, UTC freshness window, explicit missing-section and partial-failure states | Input evidence guardrail and fact-grounded decisions |
| Supply reader | `lib/ai/fulfillment/supply-chain-reader.ts` | Authenticated read-only calls to stock, replenishment and preparation endpoints; bounded origin, response and timeout checks | Cross-system observation without write authority |
| Deterministic draft | `lib/ai/fulfillment/draft.ts` | Stable customer-facing draft and operational assessment used by Faux replay and safe fallback | Human-reviewable fulfillment explanation |
| Output guardrail | `lib/ai/fulfillment/output-guardrail.ts` | Schema, quantity, unit, sign and shipment-promise checks; returns concrete violations to the correction loop | Anti-hallucination output checks and up to two Self-Correction rounds |
| Proposal and compensation store | `lib/ai/fulfillment/proposal-store.ts` | Atomic JSON transactions, file lock, fsync, generation/version checks, snapshots, approval and compensation transitions | Four-level proposal harness, `canSend=false`, versioned Undo |
| Runtime context bridge | `lib/agent-engine/agent/operational-opening.ts` | Appends validated, time-bounded operational facts to the user opening while keeping system policy stable | Context engineering with explicit fact boundaries |
| Pi observation fixture | `lib/agent-runtime/pi/tool-observation-fixture.ts` | Deterministic multi-step observation stream for zero-cost protocol replay | Offline regression and protocol evaluation |
| Demonstration surface | `scripts/portfolio/`, `examples/fulfillment-demo/`, `docs/portfolio/assets/` | Local workbench, browser smoke, persistence smoke and responsive screenshots | Reviewable Agent trace and proposal flow |

## Guardrail and execution contract

1. `read` tools execute inside the Agent loop and return validated observations.
2. `reversible_write` records the current version and snapshot before an executor applies it; a matching current version is required for Compensation Undo.
3. `external` creates a durable pending proposal. The proposal is always `canSend=false` until a human approves it outside the model loop.
4. `irreversible` remains disabled in the portfolio harness and cannot be reached through model output.

## Public and local-only files

- Keep root `LICENSE` and all upstream copyright headers. No author or license statement is rewritten.
- Internal audit snapshots and process notes are copied to the local `docs/internal/` working area and ignored by Git. The public tree keeps implementation, tests, architecture and run commands.
- `.changes/.gitkeep` remains only as an empty release-check marker; release fragments and working notes are ignored.

## Verification map

| Claim | Primary tests/commands |
| --- | --- |
| Evidence scope, freshness and partial failures | `lib/ai/fulfillment/evidence.test.ts`, `supply-chain-reader.test.ts` |
| Tool loop and provider compatibility | `lib/ai/fulfillment/agent.test.ts`, `compatible-http.test.ts`, `pnpm portfolio:typecheck` |
| Draft and output correction | `draft.test.ts`, `output-guardrail.test.ts` |
| Durable proposals, approval and Undo | `proposal-store.test.ts`, `python scripts/portfolio/persistence-smoke.py` |
| End-to-end portfolio workbench | `pnpm portfolio:test`, `node scripts/portfolio/browser-smoke.mjs` |
| Full platform gates | `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, CI Postgres container jobs |
