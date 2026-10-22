# Fulfillment verification architecture

The CRM foundation supplies tenant isolation, auth, the Pi runtime and the
operator UI. The portfolio extension adds a read-only fulfillment observation
lane and a proposal executor with explicit human approval boundaries.

~~~mermaid
flowchart LR
  Buyer[Buyer question] --> Pi[Pi Agent loop]
  Pi -->|read_stock / read_replenishment / read_preparation| Reader[SupplyChainReader]
  Reader --> Evidence[Zod Evidence + scope + UTC freshness]
  Evidence --> Obs[Observation report]
  Obs --> Pi
  Pi --> Candidate[Structured reply + proposed actions]
  Candidate --> Guard[Output guardrail]
  Guard -->|violations| Correct[Up to 2 no-tool Self-Correction rounds]
  Correct --> Candidate
  Guard -->|passed| Draft[Human-reviewable draft]
  Candidate --> Store[Durable ProposalStore]
  Store --> Review[Operator review]
  Review -->|reversible_write| Execute[Version-checked executor]
  Execute --> Undo[Compensation Undo]
  Review -->|external| Approval[Explicit approval]
  Approval --> Send[External adapter]
  Store --> Audit[(Audit + generation)]
~~~

## Runtime boundaries

- `agent.ts` selects a Faux replay provider for deterministic CI or a
  compatible OpenAI/DeepSeek provider from server-side environment variables.
- The loop can call only read tools. Tool observations are data, never
  instructions. The read path is scoped to one organization and SKU.
- `evidence.ts` rejects unknown fields and mismatched organization/SKU values,
  drops snapshots outside the seven-day UTC window, and preserves unavailable
  sections as explicit gaps.
- `draft.ts` provides the deterministic explanation used by replay and by the
  final safe fallback. `operational-opening.ts` injects validated facts into a
  user opening without changing the stable system policy.

## Output and proposal controls

`output-guardrail.ts` parses the model's structured reply, checks every claimed
quantity against the valid evidence, preserves ASCII/Unicode sign semantics,
rejects unsupported units, and blocks shipment promises when the report cannot
confirm shipment. Concrete violation codes are fed back to the provider for at
most two correction rounds. A failed correction falls back to the deterministic
draft.

`proposal-store.ts` persists drafts and actions using a process queue, an
exclusive lock file, atomic replacement and `fsync`. Every reversible write
stores the previous opportunity value and expected version. Compensation Undo
requires the current version to match, then increments the version and records
an audit entry. External sends remain pending with `canSend=false` until the
operator approves them outside the model loop. Irreversible actions are not
available to this harness.

## Validation surfaces

The module tests cover evidence parsing, stale and partial reads, provider
compatibility, multi-step observations, output violations, correction fallback,
proposal persistence, approval and compensation conflicts. The portfolio
commands additionally run browser and persistence smoke tests. The repository's
CI executes the 153-item fulfillment regression set together with the real
Postgres container jobs for tenant and schema invariants.

See [CORE_MODULES.md](../CORE_MODULES.md) for the upstream/extension boundary
and the source-to-resume claim map.
