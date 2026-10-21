import { describe, expect, it } from "vitest";
import { assessOperationalEvidence } from "./evidence";
import { guardCustomerOutput, parseCustomerOutput } from "./output-guardrail";

const report = assessOperationalEvidence({ schema_version: 1, organization_id: "demo-org", sku: "AUD-001", collected_at: "2026-09-03T12:00:00Z", source_kind: "supply_chain_http",
  stock: { sku: "AUD-001", quantity: 18, snapshot_date: "2026-09-03" }, replenishment: null, preparation: null, purchases: [] },
{ organizationId: "demo-org", sku: "AUD-001", now: new Date("2026-09-03T12:00:00Z") });
describe("customer output guardrail", () => {
  it("accepts grounded inventory and explicit uncertainty", () => {
    expect(guardCustomerOutput({ reply: "历史库存18件，无法承诺发货日期。", claims: [{ kind: "stock", quantity: 18 }] }, report).ok).toBe(true);
  });
  it.each(["保证明天发货", "明天发货", "已经发货", "预计今天发货", "We will ship tomorrow", "不能承诺，但是明天发货", "不能承诺，但已经发货", "周五发货", "48小时内出库", "可发18件", "已经出库"])("blocks shipping assertion %s", (reply) => {
    expect(guardCustomerOutput({ reply, claims: [] }, report).violations).toContain("shipment_promise_forbidden");
  });
  it.each(["库存999件", "库存为999", "stock 999 units", "库存十九件"])("blocks invented quantity %s", (reply) => {
    expect(guardCustomerOutput({ reply, claims: [{ kind: "stock", quantity: 18 }] }, report).ok).toBe(false);
  });
  it("does not treat a disclaimer as a shipping assertion", () => {
    expect(guardCustomerOutput({ reply: "不能据此认定已经发货，目前无法承诺具体发货日期。", claims: [] }, report).ok).toBe(true);
  });
  it("requires every quantity to be registered", () => {
    expect(guardCustomerOutput({ reply: "库存18件", claims: [] }, report).ok).toBe(false);
  });
  it("does not silently turn item quantities into box quantities", () => {
    expect(guardCustomerOutput({ reply: "库存18箱", claims: [{kind:"stock",quantity:18}] },report).violations).toContain("unsupported_quantity_unit");
  });
  it("rejects claims without effective stock", () => {
    const stale = structuredClone(report); stale.facts.stock = null;
    expect(guardCustomerOutput({ reply: "库存18件", claims: [{ kind: "stock", quantity: 18 }] }, stale).ok).toBe(false);
  });
  it("fails closed on malformed and oversized outputs", () => {
    expect(guardCustomerOutput({ reply: "x", claims: [], canSend: true }, report).ok).toBe(false);
    expect(guardCustomerOutput({ reply: "x".repeat(6001), claims: [] }, report).ok).toBe(false);
    expect(parseCustomerOutput("not JSON")).toBeNull();
  });
});
