// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentRuntime } from "@/lib/agent-runtime/pi/runtime";
import { generateOperationalDraft, type EvidenceReader } from "./draft";
import type { OperationalEvidence } from "./evidence";
import type { ReadReceipt } from "./supply-chain-reader";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const SKU = "AUD-001";
const ORGANIZATION = "portfolio-org";
function evidence(quantity = 18): OperationalEvidence {
  return {
    schema_version: 1,
    organization_id: ORGANIZATION,
    sku: SKU,
    collected_at: NOW.toISOString(),
    source_kind: "supply_chain_http",
    stock: { sku: SKU, quantity, snapshot_date: "2026-09-03" },
    replenishment: { sku: SKU, suggested_qty: 72, assessment_status: "reference" },
    preparation: {
      record_id: "R-1001",
      sku: SKU,
      business_version: 3,
      outer_box_mark_present: true,
    },
    purchases: [{ po_no: "PO-20260903-001", sku: SKU, status: "confirmed" }],
  };
}
function receipt(value: OperationalEvidence, failures: ReadReceipt["failures"] = []): ReadReceipt {
  return {
    evidence: value,
    failures,
    receivedAt: NOW.toISOString(),
    requests: [
      { method: "POST", path: "/api/auth/login", status: 200 },
      { method: "POST", path: "/api/agent/tools/query-stock-level", status: 200 },
    ],
  };
}
function generate(
  reader: EvidenceReader,
  options: Partial<{ now: Date; mode: "current_check" | "historical_replay" }> = {},
) {
  return generateOperationalDraft({
    organizationId: ORGANIZATION,
    sku: SKU,
    reader,
    now: NOW,
    mode: "current_check",
    ...options,
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("actual CRM Pi adapter with official scripted Faux provider", () => {
  it("changes the draft when the executed read tool observes different stock", async () => {
    const firstReader = vi.fn<EvidenceReader>(async () => receipt(evidence(18)));
    const secondReader = vi.fn<EvidenceReader>(async () => receipt(evidence(5)));
    const first = await generate(firstReader);
    const second = await generate(secondReader);
    expect(firstReader).toHaveBeenCalledExactlyOnceWith(SKU, ORGANIZATION);
    expect(secondReader).toHaveBeenCalledExactlyOnceWith(SKU, ORGANIZATION);
    expect(first.draft).toContain("当时现存18件");
    expect(second.draft).toContain("当时现存5件");
    expect(second.draft).not.toContain("当时现存18件");
    expect(first.draft).not.toEqual(second.draft);
    expect(first.provider).toBe("official-pi-faux");
    expect(first.runtime).toBe("upstream-crm-pi-adapter");
  });

  it("returns runtime events and observations from the actual Pi execution", async () => {
    const run = vi.spyOn(PiAgentRuntime.prototype, "run");
    const result = await generate(async () => receipt(evidence()));
    expect(run).toHaveBeenCalledOnce();
    const runtimeResult: Awaited<ReturnType<PiAgentRuntime["run"]>> =
      await run.mock.results[0]!.value;
    expect(result.events).toEqual(
      runtimeResult.events.map((event, index) => ({ seq: index + 1, type: event.type })),
    );
    expect(result.draft).toBe(runtimeResult.finalText);
    expect(result.toolCalls).toEqual([{ name: "read_operational_evidence" }]);
    const types = result.events.map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "agent_start",
        "tool_execution_start",
        "tool_execution_end",
        "agent_end",
      ]),
    );
    expect(types.indexOf("tool_execution_start")).toBeLessThan(types.indexOf("tool_execution_end"));
    expect(result.events.map((event) => event.seq)).toEqual(
      result.events.map((_, index) => index + 1),
    );
  });

  it("has exactly one read capability and no send, write, approval or persistence operation", async () => {
    const fetchTripwire = vi.fn(async () => {
      throw new Error("unexpected_network_request");
    });
    vi.stubGlobal("fetch", fetchTripwire);
    const run = vi.spyOn(PiAgentRuntime.prototype, "run");
    const result = await generate(async () => receipt(evidence()));
    const tools = run.mock.calls[0]![0].tools!;
    expect(tools.map(({ name, capability, effect }) => ({ name, capability, effect }))).toEqual([
      { name: "read_operational_evidence", capability: "read", effect: "read" },
    ]);
    expect(
      tools.some((tool) => /send|write|approve|purchase|confirm|persist/.test(tool.name)),
    ).toBe(false);
    expect(fetchTripwire).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      reviewed: false,
      sent: false,
      crmPersisted: false,
      revision: 1,
    });
    expect(result.assessment).toMatchObject({ canPromiseShipment: false, canSend: false });
    expect(result.draft).toContain("尚未发送");
  });

  it("does not state a quantity or inventory date from a stale snapshot", async () => {
    const value = evidence(987);
    value.stock!.snapshot_date = "2026-08-20";
    const result = await generate(async () => receipt(value));
    expect(result.assessment.reasons).toContain("stock_snapshot_stale");
    expect(result.assessment.facts.stock).toBeNull();
    expect(result.assessment.facts.replenishment?.suggestedQty).toBeNull();
    expect(result.draft).toContain("当前没有可用于判断的有效库存记录");
    expect(result.draft).not.toMatch(/987|2026-08-20|当时现存/);
    expect(result.assessment.canPromiseShipment).toBe(false);
  });

  it("reports missing evidence without inventing stock, fulfillment or delivery", async () => {
    const value = {
      ...evidence(),
      stock: null,
      replenishment: null,
      preparation: null,
      purchases: [],
    };
    const failures: ReadReceipt["failures"] = [
      "stock_unavailable",
      "replenishment_unavailable",
      "preparation_unavailable",
    ];
    const result = await generate(async () => receipt(value, failures));
    expect(result.readFailures).toEqual(failures);
    expect(result.assessment.status).toBe("needs_review");
    expect(result.draft).toContain("当前没有可用于判断的有效库存记录");
    expect(result.draft).toContain("无法承诺具体发货日期");
    expect(result.draft).not.toMatch(/现存\d|准备记录已有值|采购意向已确认/);
    expect(result).toMatchObject({ sent: false, crmPersisted: false });
  });

  it("retains the distinction between procurement, preparation and customer shipment", async () => {
    const result = await generate(async () => receipt(evidence()));
    expect(result.draft).toContain("尚未确认它与您的订单关联");
    expect(result.draft).toContain("不能据此认定已经发货");
    expect(result.draft).toContain("不代表供应商收单、到货入库或客户订单出库");
    expect(result.draft).toContain("不是您的订单可分配库存或实时发货承诺");
    expect(result.assessment.canSend).toBe(false);
  });

  it("does not include foreign-organization observations in the draft", async () => {
    const value = evidence(654);
    value.organization_id = "foreign-org";
    const result = await generate(async () => receipt(value));
    expect(result.assessment.status).toBe("blocked");
    expect(result.assessment.facts.stock).toBeNull();
    expect(result.draft).toContain("资料校验未通过");
    expect(result.draft).not.toMatch(/654|foreign-org|R-1001/);
  });

  it.each(["organization", "sku", "injection"] as const)(
    "removes the entire original envelope from the returned JSON after a blocked %s assessment",
    async (kind) => {
      const privateQuantity = 946812753;
      const privateOrg = "FOREIGN-PRIVATE-ORG";
      const privateSku = "FOREIGN-PRIVATE-SKU";
      const privateInstruction = "UNTRUSTED_INSTRUCTIONS_DO_NOT_ECHO_20261021";
      const value = evidence(privateQuantity);
      value.preparation!.record_id = "R-7777";
      value.purchases[0]!.po_no = "PO-PRIVATE-ENVELOPE";
      if (kind === "organization") value.organization_id = privateOrg;
      if (kind === "sku") {
        value.sku = privateSku;
        value.stock!.sku = privateSku;
        value.replenishment!.sku = privateSku;
        value.preparation!.sku = privateSku;
        value.purchases[0]!.sku = privateSku;
      }
      const inputValue = kind === "injection" ? { ...value, notes: privateInstruction } : value;
      const result = await generate(async () => receipt(inputValue));
      expect(result.assessment.status).toBe("blocked");
      expect(result.evidence).toBeNull();
      expect(result.assessment.facts).toEqual({
        stock: null,
        replenishment: null,
        preparation: null,
        purchases: [],
      });
      const wholeResponse = JSON.stringify(result);
      for (const marker of [
        String(privateQuantity),
        privateOrg,
        privateSku,
        privateInstruction,
        "R-7777",
        "PO-PRIVATE-ENVELOPE",
      ])
        expect(wholeResponse).not.toContain(marker);
      // The caller's trusted requested scope may remain for diagnostics.
      expect(result.assessment.scope).toMatchObject({ organizationId: ORGANIZATION, sku: SKU });
      expect(result).toMatchObject({ sent: false, crmPersisted: false });
    },
  );

  it("marks historical replay separately and retains actual HTTP collection metadata", async () => {
    const receivedAt = "2026-10-21T08:00:00.000Z";
    const value = evidence();
    value.collected_at = receivedAt;
    const result = await generate(async () => ({ ...receipt(value), receivedAt }), {
      now: new Date(receivedAt),
      mode: "historical_replay",
    });
    expect(result.mode).toBe("historical_replay");
    expect(result.asOf).toBe("2026-09-03T12:00:00.000Z");
    expect(result.receivedAt).toBe(receivedAt);
    expect(result.evidence).not.toBeNull();
    expect(result.evidence?.collected_at).toBe(result.asOf);
    expect(result.assessment.facts.stock?.snapshotDate).toBe("2026-09-03");
    expect(result.sent).toBe(false);
  });

  it("checks current-mode freshness instead of treating the historical fixture date as live inventory", async () => {
    const now = new Date("2026-10-21T08:00:00Z");
    const value = evidence();
    value.collected_at = now.toISOString();
    const result = await generate(async () => receipt(value), { now });
    expect(result.mode).toBe("current_check");
    expect(result.assessment.reasons).toContain("stock_snapshot_stale");
    expect(result.draft).not.toContain("当时现存18件");
    expect(result.draft).toContain("需要运营进一步核对");
  });

  it("sets the default current-check clock after an asynchronous read completes", async () => {
    let collectedAt = "";
    const result = await generateOperationalDraft({
      organizationId: ORGANIZATION,
      sku: SKU,
      mode: "current_check",
      reader: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        collectedAt = new Date().toISOString();
        const value = evidence();
        value.collected_at = collectedAt;
        value.stock!.snapshot_date = collectedAt.slice(0, 10);
        return { ...receipt(value), receivedAt: collectedAt };
      },
    });
    expect(result.evidence).not.toBeNull();
    expect(result.assessment.reasons).not.toContain("collection_in_future");
    expect(result.assessment.facts.stock?.quantity).toBe(18);
    expect(Date.parse(result.asOf)).toBeGreaterThanOrEqual(Date.parse(collectedAt));
    expect(result.receivedAt).toBe(collectedAt);
  });
});
