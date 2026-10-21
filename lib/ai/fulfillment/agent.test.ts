import { describe, expect, it } from "vitest";
import type { AgentRuntime, AgentTurnInput } from "@/lib/agent-runtime/types";
import { generateAgentDraft } from "./agent";
import { loadAgentConfig } from "./agent-config";
import type { ReadReceipt } from "./supply-chain-reader";

const now = new Date("2026-09-03T12:00:00Z");
function receipt(): ReadReceipt {
  return { evidence: { schema_version: 1, organization_id: "demo-org", sku: "AUD-001", collected_at: now.toISOString(), source_kind: "supply_chain_http",
    stock: { sku: "AUD-001", quantity: 18, snapshot_date: "2026-09-03" }, replenishment: { sku: "AUD-001", suggested_qty: 72, assessment_status: "ready" },
    preparation: { sku: "AUD-001", record_id: "R-1001", business_version: 1, outer_box_mark_present: true }, purchases: [] }, receivedAt: now.toISOString(), failures: [], requests: [] };
}
const base = { organizationId: "demo-org", sku: "AUD-001", mode: "historical_replay" as const, now, config: loadAgentConfig({}) };

describe("multi-step fulfillment agent", () => {
  it("runs actual Pi Faux across three separate reads and only proposes writes", async () => {
    const sections: string[] = [];
    const result = await generateAgentDraft({ ...base, reader: async (_sku, _org, section) => { sections.push(section); return receipt(); } });
    expect(sections).toEqual(["stock", "replenishment", "preparation"]);
    expect(result.guardrail.status).toBe("passed");
    expect(result.toolCalls.map((call) => call.name)).toEqual(["read_stock", "read_replenishment", "read_preparation", "propose_update_opportunity", "propose_buyer_reply"]);
    expect(result.proposedActions.map((action) => action.effect)).toEqual(["reversible_write", "external"]);
    expect(result.draft).toContain("当时现存18件");
    expect(result.observations.some((observation) => observation.kind === "generation")).toBe(true);
    expect(result.sent).toBe(false);
  });
  it("keeps a mixed-scope source blocked even after later reads", async () => {
    const result = await generateAgentDraft({ ...base, reader: async (_sku, _org, section) => {
      const data = receipt(); if (section === "preparation") data.evidence.organization_id = "other-org"; return data;
    } });
    expect(result.assessment.status).toBe("blocked"); expect(result.evidence).toBeNull(); expect(result.proposedActions).toEqual([]);
  });
  it("excludes stale stock in current-check mode", async () => {
    const result = await generateAgentDraft({ ...base, mode: "current_check", now: new Date("2026-10-21T12:00:00Z"), reader: async () => {
      const data = receipt(); data.evidence.collected_at = "2026-10-21T12:00:00Z"; data.receivedAt = data.evidence.collected_at; return data;
    } });
    expect(result.assessment.facts.stock).toBeNull(); expect(result.draft).not.toContain("18件");
  });
  it.each([1, 2, 3])("corrects at most twice with %s invalid candidate(s)", async (invalid) => {
    const inputs: AgentTurnInput[] = [];
    const runtime = { run: async (input: AgentTurnInput) => {
      inputs.push(input);
      if (inputs.length === 1) await input.tools!.find((tool) => tool.name === "read_stock")!.execute({ sku: "AUD-001" }, { toolCallId: "read" });
      return { finalText: JSON.stringify(inputs.length <= invalid ? { reply: "保证明天发货，库存999件", claims: [] } : { reply: "库存18件，交期尚需核实。", claims: [{ kind: "stock", quantity: 18 }] }), events: [], toolCalls: [] };
    } } as unknown as AgentRuntime;
    const result = await generateAgentDraft({ ...base, runtime, reader: async () => receipt() });
    expect(inputs.length).toBe(Math.min(invalid + 1, 3));
    expect(result.guardrail.corrections).toBe(Math.min(invalid, 2));
    expect(result.guardrail.status).toBe(invalid < 3 ? "passed" : "fallback");
    expect(result.draft).not.toContain("999");
    expect(inputs[1]!.prompt).toContain("shipment_promise_forbidden");
    expect(inputs.slice(1).every((input) => input.tools?.length === 0)).toBe(true);
  });
  it("does not fabricate evidence when the model omits every read", async () => {
    const runtime = { run: async () => ({ finalText: '{"reply":"库存18件","claims":[{"kind":"stock","quantity":18}]}', events: [], toolCalls: [] }) } as unknown as AgentRuntime;
    const result = await generateAgentDraft({ ...base, runtime, reader: async () => receipt() });
    expect(result.guardrail.status).toBe("fallback"); expect(result.assessment.facts.stock).toBeNull(); expect(result.proposedActions).toEqual([]);
  });
  it("keeps real mode opt-in and rejects absent keys or credential-bearing URLs", () => {
    expect(loadAgentConfig({}).engine).toBe("faux");
    expect(() => loadAgentConfig({ PORTFOLIO_LLM_ENGINE: "openai" })).toThrow("key_required");
    expect(() => loadAgentConfig({ PORTFOLIO_LLM_ENGINE: "deepseek", PORTFOLIO_LLM_API_KEY: "synthetic", PORTFOLIO_LLM_BASE_URL: "https://user:password@example.invalid" })).toThrow("origin_invalid");
    expect(loadAgentConfig({ PORTFOLIO_LLM_ENGINE: "openai-compatible", PORTFOLIO_LLM_API_KEY: "synthetic", PORTFOLIO_LLM_BASE_URL: "http://127.0.0.1:19999/v1" }).binding.provider).toBe("deepseek");
  });
});
