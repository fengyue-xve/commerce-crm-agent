import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { AgentDraftResult } from "./agent";

const opportunitySchema = z.strictObject({ sku: z.enum(["AUD-001", "DEM-001"]), stage: z.enum(["new", "needs_review", "following_up"]), tags: z.array(z.string().max(30)).max(5), version: z.number().int().positive() });
const draftSchema = z.strictObject({ id: z.uuid(), sku: z.enum(["AUD-001", "DEM-001"]), revision: z.literal(1), createdAt: z.number(), reply: z.string().max(6000), reviewed: z.boolean(), blocked: z.boolean(), canSend: z.literal(false) });
const proposalSchema = z.strictObject({
  id: z.uuid(), draftId: z.uuid(), organizationId: z.string(), sku: z.enum(["AUD-001", "DEM-001"]),
  effect: z.enum(["reversible_write", "external", "irreversible"]),
  status: z.enum(["pending", "executed", "approved", "compensated", "rejected"]), revision: z.number().int().positive(),
  expectedVersion: z.number().int().positive(), stage: z.enum(["needs_review", "following_up"]).nullable(), tags: z.array(z.string().max(30)).max(5),
  before: opportunitySchema.nullable(), afterVersion: z.number().int().positive().nullable(), canSend: z.literal(false), createdAt: z.number(),
});
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1), organizationId: z.string().min(1), generation: z.number().int().positive(),
  opportunities: z.array(opportunitySchema).length(2), drafts: z.array(draftSchema).max(100), proposals: z.array(proposalSchema).max(500),
  audit: z.array(z.strictObject({ id: z.uuid(), at: z.string(), action: z.string(), target: z.string(), generation: z.number().int().positive() })),
});
type State = z.infer<typeof stateSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export class ProposalConflict extends Error { constructor(public readonly code: string) { super(code); } }
const initial = (org: string): State => ({ schemaVersion: 1, organizationId: org, generation: 1,
  opportunities: ["AUD-001", "DEM-001"].map((sku) => ({ sku: sku as "AUD-001" | "DEM-001", stage: "new", tags: [], version: 1 })), drafts: [], proposals: [], audit: [] });

/** Atomic JSON transactions + process/file lock. Corrupt state fails closed instead of reseeding. */
export class ProposalStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;
  constructor(path: string, readonly organizationId: string) { this.path = resolve(path); }
  private transaction<T>(operation: (state: State) => T): Promise<T> {
    const result = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const lock = await open(this.path + ".lock", "wx", 0o600).catch(() => { throw new ProposalConflict("state_busy"); });
      const temporary = this.path + "." + randomUUID() + ".tmp";
      try {
        let state: State;
        try { state = stateSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProposalConflict("state_corrupt");
          state = initial(this.organizationId);
        }
        if (state.organizationId !== this.organizationId) throw new ProposalConflict("organization_scope_mismatch");
        const value = operation(state);
        stateSchema.parse(state);
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.path);
        return structuredClone(value);
      } finally {
        await lock.close(); await unlink(this.path + ".lock");
        await unlink(temporary).catch(() => undefined);
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private audit(state: State, action: string, target: string) {
    state.audit.push({ id: randomUUID(), at: new Date().toISOString(), action, target, generation: state.generation });
  }
  snapshot() { return this.transaction((state) => state); }
  recordDraft(draft: AgentDraftResult, expectedVersion: number, expectedGeneration: number) {
    return this.transaction((state) => {
      if (state.generation !== expectedGeneration) throw new ProposalConflict("demo_generation_changed");
      if (state.drafts.some((row) => row.id === draft.id)) return state.proposals.filter((row) => row.draftId === draft.id);
      if (state.drafts.length >= 100 || state.proposals.length + draft.proposedActions.length > 500) throw new ProposalConflict("demo_capacity_reset_required");
      const sku = z.enum(["AUD-001", "DEM-001"]).parse(draft.assessment.scope.sku);
      if (draft.assessment.scope.organizationId !== this.organizationId) throw new ProposalConflict("organization_scope_mismatch");
      state.drafts.push({ id: draft.id, sku, revision: 1, createdAt: Date.now(), reply: draft.draft, reviewed: false,
        blocked: draft.assessment.status === "blocked", canSend: false });
      if (draft.assessment.status !== "blocked" && draft.guardrail.status === "passed") {
        for (const action of draft.proposedActions) state.proposals.push({ id: randomUUID(), draftId: draft.id, organizationId: this.organizationId,
          sku, effect: action.effect, status: "pending", revision: 1, expectedVersion, before: null, afterVersion: null, canSend: false, createdAt: Date.now(),
          stage: action.effect === "reversible_write" ? action.stage : null, tags: action.effect === "reversible_write" ? action.tags : [] });
      }
      this.audit(state, "draft_and_proposals_recorded", draft.id);
      return state.proposals.filter((row) => row.draftId === draft.id);
    });
  }
  review(id: string, revision: number) {
    return this.transaction((state) => {
      const draft = state.drafts.find((row) => row.id === id);
      if (!draft || Date.now() - draft.createdAt > 30 * 60_000) throw new ProposalConflict("draft_expired");
      if (revision !== draft.revision || draft.blocked) throw new ProposalConflict("draft_not_reviewable");
      if (!draft.reviewed) { draft.reviewed = true; this.audit(state, "draft_reviewed", id); }
      return { id, reviewed: true, sent: false, crmPersisted: false, demoPersisted: true };
    });
  }
  act(id: string, revision: number, action: "execute" | "approve" | "undo" | "reject") {
    return this.transaction((state) => {
      const proposal = state.proposals.find((row) => row.id === id);
      if (!proposal || proposal.organizationId !== this.organizationId) throw new ProposalConflict("proposal_not_found");
      if (proposal.revision !== revision) throw new ProposalConflict("proposal_revision_changed");
      const draft = state.drafts.find((row) => row.id === proposal.draftId);
      if (!draft || draft.blocked) throw new ProposalConflict("proposal_draft_invalid");
      if (action !== "undo" && action !== "reject" && Date.now() - draft.createdAt > 30 * 60_000) throw new ProposalConflict("draft_expired");
      if (proposal.effect === "irreversible") throw new ProposalConflict("irreversible_disabled");
      const opportunity = state.opportunities.find((row) => row.sku === proposal.sku)!;
      if (action === "reject" && proposal.status === "pending") proposal.status = "rejected";
      else if (action === "execute" && proposal.effect === "reversible_write" && proposal.status === "pending") {
        if (opportunity.version !== proposal.expectedVersion) throw new ProposalConflict("opportunity_version_changed");
        proposal.before = structuredClone(opportunity);
        opportunity.stage = proposal.stage!; opportunity.tags = [...proposal.tags]; opportunity.version++;
        proposal.afterVersion = opportunity.version; proposal.status = "executed";
      } else if (action === "undo" && proposal.effect === "reversible_write" && proposal.status === "executed") {
        if (!proposal.before || opportunity.version !== proposal.afterVersion) throw new ProposalConflict("compensation_version_conflict");
        opportunity.stage = proposal.before.stage; opportunity.tags = [...proposal.before.tags]; opportunity.version++;
        proposal.status = "compensated";
      } else if (action === "approve" && proposal.effect === "external" && proposal.status === "pending") {
        if (!draft.reviewed) throw new ProposalConflict("human_draft_review_required");
        proposal.status = "approved"; // Approval is a durable receipt; there is no sender adapter.
      } else throw new ProposalConflict("proposal_transition_forbidden");
      proposal.revision++; this.audit(state, `proposal_${action}`, id);
      return { proposal, opportunity, sent: false, canSend: false };
    });
  }
  reset(expectedGeneration: number) {
    return this.transaction((state) => {
      if (state.generation !== expectedGeneration) throw new ProposalConflict("demo_generation_changed");
      const seed = initial(this.organizationId);
      state.generation++; state.opportunities = seed.opportunities; state.drafts = []; state.proposals = [];
      this.audit(state, "demo_baseline_reset", "synthetic_only");
      return { generation: state.generation, reset: true, sent: false };
    });
  }
}
