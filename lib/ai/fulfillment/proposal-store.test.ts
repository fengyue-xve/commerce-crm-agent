// @vitest-environment node
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProposalStore } from "./proposal-store";
import type { AgentDraftResult } from "./agent";

function draft(): AgentDraftResult {
  return { id: randomUUID(), revision: 1, draft: "暂不能确认交期，请人工核实。", assessment: { status: "needs_review", scope: { sku: "AUD-001", organizationId: "demo-org" } },
    guardrail: { status: "passed" }, proposedActions: [{ effect: "reversible_write", toolCallId: "a", stage: "needs_review", tags: ["核实"] }, { effect: "external", toolCallId: "b" }] } as AgentDraftResult;
}
async function fixture() {
  const file = join(await mkdtemp(join(tmpdir(), "fulfillment-proposals-")), "state.json");
  const store = new ProposalStore(file, "demo-org"); const row = draft();
  const proposals = await store.recordDraft(row, 1, 1);
  return { file, store, row, proposals };
}
describe("durable proposal and compensation harness", () => {
  it("records proposals without mutating the opportunity, and survives a new store instance", async () => {
    const { file, proposals } = await fixture(); const snapshot = await new ProposalStore(file, "demo-org").snapshot();
    expect(snapshot.opportunities[0]!.version).toBe(1); expect(snapshot.proposals).toEqual(proposals); expect(snapshot.drafts).toHaveLength(1);
  });
  it("executes outside the loop then compensates by a new versioned write", async () => {
    const { store, proposals } = await fixture();
    const result = await store.act(proposals[0]!.id, 1, "execute");
    expect(result.proposal.before!.stage).toBe("new"); expect(result.opportunity.version).toBe(2);
    const undone = await store.act(proposals[0]!.id, 2, "undo");
    expect(undone.opportunity.stage).toBe("new"); expect(undone.opportunity.version).toBe(3); expect(undone.proposal.status).toBe("compensated");
    expect((await store.snapshot()).audit.map((row) => row.action)).toContain("proposal_undo");
  });
  it("does not approve an external action before explicit review or send after approval", async () => {
    const { store, row, proposals } = await fixture();
    await expect(store.act(proposals[1]!.id, 1, "approve")).rejects.toThrow("human_draft_review_required");
    await store.review(row.id, 1);
    const result = await store.act(proposals[1]!.id, 1, "approve");
    expect(result.proposal.status).toBe("approved"); expect(result.canSend).toBe(false); expect(result.sent).toBe(false);
  });
  it("rejects stale revisions and replayed execution", async () => {
    const { store, proposals } = await fixture();
    await store.act(proposals[0]!.id, 1, "execute");
    await expect(store.act(proposals[0]!.id, 1, "execute")).rejects.toThrow("proposal_revision_changed");
  });
  it("cannot undo across another opportunity update", async () => {
    const { store, proposals } = await fixture(); await store.act(proposals[0]!.id, 1, "execute");
    const other = await store.recordDraft(draft(), 2, 1); await store.act(other[0]!.id, 1, "execute");
    await expect(store.act(proposals[0]!.id, 2, "undo")).rejects.toThrow("compensation_version_conflict");
    expect((await store.snapshot()).opportunities[0]!.version).toBe(3);
  });
  it("rejects corrupt disk state instead of silently losing history", async () => {
    const { store, file } = await fixture(); await writeFile(file, "broken"); await expect(store.snapshot()).rejects.toThrow("state_corrupt");
  });
  it("rejects cross-organization state", async () => {
    const { file } = await fixture(); await expect(new ProposalStore(file, "other-org").snapshot()).rejects.toThrow("organization_scope_mismatch");
  });
  it("reset restores seed and invalidates old IDs and generations, retaining audit", async () => {
    const { store, proposals } = await fixture(); await store.reset(1);
    expect((await store.snapshot()).opportunities[0]!.stage).toBe("new");
    await expect(store.act(proposals[0]!.id, 1, "execute")).rejects.toThrow("proposal_not_found");
    await expect(store.recordDraft(draft(), 1, 1)).rejects.toThrow("demo_generation_changed");
    expect((await store.snapshot()).audit.at(-1)!.action).toBe("demo_baseline_reset");
  });
  it("irreversible proposals are always disabled", async () => {
    const { store, file, proposals } = await fixture(); const data = JSON.parse(await readFile(file, "utf8"));
    data.proposals[0].effect = "irreversible"; await writeFile(file, JSON.stringify(data));
    await expect(store.act(proposals[0]!.id, 1, "execute")).rejects.toThrow("irreversible_disabled");
  });
  it("serializes concurrent revisions so only one applies", async () => {
    const { store, proposals } = await fixture(); const results = await Promise.allSettled([store.act(proposals[0]!.id, 1, "execute"), store.act(proposals[0]!.id, 1, "execute")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.snapshot()).opportunities[0]!.version).toBe(2);
  });
});
