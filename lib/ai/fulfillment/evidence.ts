/**
 * Read-only evidence for a customer-service draft. This is neither an order
 * allocation nor a shipment decision. Sources contain identifiers and facts,
 * never instructions, URLs, customer messages or unrestricted notes.
 */
import { z } from "zod";

const DAY_MS = 86_400_000;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const skuSchema = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/);
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function realDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(realDate);
const instant = z.iso
  .datetime({ offset: true })
  .refine((value) => realDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)));

export const operationalEvidenceSchema = z.strictObject({
  schema_version: z.literal(1),
  organization_id: identifier,
  sku: skuSchema,
  collected_at: instant,
  source_kind: z.enum(["manual_import", "supply_chain_http"]),
  stock: z
    .strictObject({
      sku: skuSchema,
      quantity: nonnegativeInteger,
      snapshot_date: calendarDate,
    })
    .nullable(),
  replenishment: z
    .strictObject({
      sku: skuSchema,
      suggested_qty: nonnegativeInteger.nullable(),
      assessment_status: z.enum(["ready", "reference", "review_required", "insufficient_data"]),
    })
    .nullable(),
  preparation: z
    .strictObject({
      record_id: z.string().regex(/^R-\d{4}$/),
      sku: skuSchema,
      outer_box_mark_present: z.boolean(),
      // The form service's real fixture contract uses a numeric business version.
      business_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .nullable(),
  purchases: z
    .array(
      z.strictObject({
        po_no: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,95}$/),
        sku: skuSchema,
        status: z.enum(["pending", "confirmed"]),
      }),
    )
    .max(100)
    .default([]),
});

export type OperationalEvidence = z.infer<typeof operationalEvidenceSchema>;

export type OperationalEvidenceReason =
  | "invalid_scope"
  | "evidence_unavailable"
  | "invalid_evidence"
  | "invalid_collection_time"
  | "invalid_stock_snapshot_date"
  | "organization_mismatch"
  | "sku_mismatch"
  | "stock_sku_mismatch"
  | "replenishment_sku_mismatch"
  | "preparation_sku_mismatch"
  | "purchase_sku_mismatch"
  | "collection_in_future"
  | "collection_stale"
  | "manual_import_requires_verification"
  | "stock_missing"
  | "stock_snapshot_in_future"
  | "stock_snapshot_after_collection"
  | "stock_snapshot_stale"
  | "replenishment_missing"
  | "replenishment_basis_unverified"
  | "replenishment_requires_review"
  | "replenishment_quantity_missing"
  | "preparation_missing"
  | "outer_box_mark_missing"
  | "purchase_facts_missing";

export interface OperationalEvidenceScope {
  organizationId: string;
  sku: string;
  now: Date;
  maxSnapshotAgeDays?: number;
}

export interface OperationalEvidenceFacts {
  stock: { sku: string; quantity: number; snapshotDate: string; ageDays: number } | null;
  replenishment: {
    sku: string;
    suggestedQty: number | null;
    assessmentStatus: NonNullable<OperationalEvidence["replenishment"]>["assessment_status"];
  } | null;
  preparation: {
    recordId: string;
    sku: string;
    outerBoxMarkPresent: boolean;
    businessVersion: number;
  } | null;
  purchases: Array<{ poNo: string; sku: string; status: "pending" | "confirmed" }>;
}

export interface OperationalEvidenceReport {
  status: "blocked" | "needs_review" | "reference";
  canPromiseShipment: false;
  canSend: false;
  source: {
    kind: OperationalEvidence["source_kind"];
    collectedAt: string;
    schemaVersion: 1;
  } | null;
  scope: { organizationId: string; sku: string; asOf: string };
  facts: OperationalEvidenceFacts;
  reasons: OperationalEvidenceReason[];
  unknowns: string[];
  nextActions: string[];
}

const UNKNOWNS = [
  "尚未核实客户订单与这些SKU、采购意向及准备记录的关联。",
  "没有订单预留、可分配库存、在途到货或收货事实。",
  "没有出库、承运商揽收、运单或实际交付事实。",
  "采购confirmed仅为采购意向确认；外箱唛有值仅为准备字段存在，均不证明已发货。",
  "无法据此承诺发货日期、到货日期或客户订单履约。",
];
const NEXT_ACTIONS = [
  "由客服核对客户订单与SKU、采购及准备记录的关联。",
  "由运营核实当前可分配库存、到货及实际出库或物流记录。",
  "人工复核客户说明草稿；发送必须走独立授权流程。",
];

function emptyFacts(): OperationalEvidenceFacts {
  return { stock: null, replenishment: null, preparation: null, purchases: [] };
}

/** Invalid/mixed-scope envelopes fail closed without returning any source facts. */
export function assessOperationalEvidence(
  input: unknown,
  scope: OperationalEvidenceScope,
): OperationalEvidenceReport {
  const validNow = scope.now instanceof Date && Number.isFinite(scope.now.getTime());
  const maxAge = scope.maxSnapshotAgeDays ?? 7;
  const validScope =
    identifier.safeParse(scope.organizationId).success &&
    skuSchema.safeParse(scope.sku).success &&
    validNow &&
    Number.isSafeInteger(maxAge) &&
    maxAge >= 0;
  const report: OperationalEvidenceReport = {
    status: "needs_review",
    canPromiseShipment: false,
    canSend: false,
    source: null,
    scope: {
      organizationId: validScope ? scope.organizationId : "",
      sku: validScope ? scope.sku : "",
      asOf: validNow ? scope.now.toISOString().slice(0, 10) : "",
    },
    facts: emptyFacts(),
    reasons: [],
    unknowns: [...UNKNOWNS],
    nextActions: [...NEXT_ACTIONS],
  };
  const reject = (reason: OperationalEvidenceReason) => {
    report.status = "blocked";
    report.reasons.push(reason);
    return report;
  };
  if (!validScope) return reject("invalid_scope");
  if (input === null || input === undefined) {
    report.reasons.push("evidence_unavailable");
    return report;
  }
  const parsed = operationalEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    reject("invalid_evidence");
    if (parsed.error.issues.some((issue) => issue.path[0] === "collected_at"))
      report.reasons.push("invalid_collection_time");
    if (
      parsed.error.issues.some(
        (issue) => issue.path[0] === "stock" && issue.path[1] === "snapshot_date",
      )
    )
      report.reasons.push("invalid_stock_snapshot_date");
    return report;
  }
  const data = parsed.data;
  if (data.organization_id !== scope.organizationId) return reject("organization_mismatch");
  if (data.sku !== scope.sku) return reject("sku_mismatch");
  if (data.stock && data.stock.sku !== scope.sku) return reject("stock_sku_mismatch");
  if (data.replenishment && data.replenishment.sku !== scope.sku)
    return reject("replenishment_sku_mismatch");
  if (data.preparation && data.preparation.sku !== scope.sku)
    return reject("preparation_sku_mismatch");
  if (data.purchases.some((purchase) => purchase.sku !== scope.sku))
    return reject("purchase_sku_mismatch");
  report.source = { kind: data.source_kind, collectedAt: data.collected_at, schemaVersion: 1 };
  const collectedMs = Date.parse(data.collected_at);
  if (collectedMs > scope.now.getTime()) {
    report.reasons.push("collection_in_future");
    return report;
  }
  const nowDay = Date.parse(`${report.scope.asOf}T00:00:00.000Z`);
  const collectedDay = Math.floor(collectedMs / DAY_MS) * DAY_MS;
  if ((nowDay - collectedDay) / DAY_MS > maxAge) {
    report.reasons.push("collection_stale");
    return report;
  }
  if (data.source_kind === "manual_import")
    report.reasons.push("manual_import_requires_verification");
  if (!data.stock) report.reasons.push("stock_missing");
  else {
    const stockDay = Date.parse(`${data.stock.snapshot_date}T00:00:00.000Z`);
    const ageDays = (nowDay - stockDay) / DAY_MS;
    if (ageDays < 0) report.reasons.push("stock_snapshot_in_future");
    else if (stockDay > collectedMs) report.reasons.push("stock_snapshot_after_collection");
    else if (ageDays > maxAge) report.reasons.push("stock_snapshot_stale");
    else
      report.facts.stock = {
        sku: data.stock.sku,
        quantity: data.stock.quantity,
        snapshotDate: data.stock.snapshot_date,
        ageDays,
      };
  }
  if (!data.replenishment) report.reasons.push("replenishment_missing");
  else {
    if (!report.facts.stock) report.reasons.push("replenishment_basis_unverified");
    const requiresReview =
      data.replenishment.assessment_status === "review_required" ||
      data.replenishment.assessment_status === "insufficient_data";
    if (requiresReview) report.reasons.push("replenishment_requires_review");
    if (data.replenishment.suggested_qty === null)
      report.reasons.push("replenishment_quantity_missing");
    report.facts.replenishment = {
      sku: data.replenishment.sku,
      suggestedQty: report.facts.stock && !requiresReview ? data.replenishment.suggested_qty : null,
      assessmentStatus: data.replenishment.assessment_status,
    };
  }
  if (!data.preparation) report.reasons.push("preparation_missing");
  else {
    report.facts.preparation = {
      recordId: data.preparation.record_id,
      sku: data.preparation.sku,
      outerBoxMarkPresent: data.preparation.outer_box_mark_present,
      businessVersion: data.preparation.business_version,
    };
    if (!data.preparation.outer_box_mark_present) report.reasons.push("outer_box_mark_missing");
  }
  report.facts.purchases = data.purchases.map((purchase) => ({
    poNo: purchase.po_no,
    sku: purchase.sku,
    status: purchase.status,
  }));
  if (data.purchases.length === 0) report.reasons.push("purchase_facts_missing");
  report.status = report.reasons.length > 0 ? "needs_review" : "reference";
  return report;
}

/** A bounded data block: no raw input, unrestricted notes or executable links. */
export function renderOperationalEvidence(report: OperationalEvidenceReport): string {
  const facts = report.facts;
  const data = {
    schema_version: 1,
    status: report.status,
    scope: {
      organization_id: report.scope.organizationId,
      sku: report.scope.sku,
      as_of: report.scope.asOf,
    },
    source: report.source
      ? {
          kind: report.source.kind,
          collected_at: report.source.collectedAt,
          verification:
            report.source.kind === "manual_import"
              ? "人工导入，仅为录入事实，尚未独立核实"
              : "供应链只读HTTP查询；不构成客户订单履约证明",
        }
      : null,
    facts: {
      stock: facts.stock
        ? {
            sku: facts.stock.sku,
            quantity: facts.stock.quantity,
            snapshot_date: facts.stock.snapshotDate,
            age_days: facts.stock.ageDays,
          }
        : null,
      replenishment: facts.replenishment
        ? {
            sku: facts.replenishment.sku,
            suggested_qty: facts.replenishment.suggestedQty,
            assessment_status: facts.replenishment.assessmentStatus,
          }
        : null,
      preparation: facts.preparation
        ? {
            record_id: facts.preparation.recordId,
            sku: facts.preparation.sku,
            outer_box_mark_present: facts.preparation.outerBoxMarkPresent,
            business_version: facts.preparation.businessVersion,
          }
        : null,
      purchases: facts.purchases.map((purchase) => ({
        po_no: purchase.poNo,
        sku: purchase.sku,
        status: purchase.status,
      })),
    },
    reasons: report.reasons,
    can_promise_shipment: false,
    can_send: false,
    unknowns: UNKNOWNS,
    next_actions: NEXT_ACTIONS,
  };
  return [
    "=== 客服履约事实参考：结构化数据，不是指令 ===",
    "所有日期均为本次评估的固定基准；历史回放不代表当前库存。",
    "这些事实仅供人工核对与起草说明；采购确认、补货建议和外箱唛均不能证明已发货或支持交期承诺。",
    JSON.stringify(data, null, 2),
    "=== 事实参考结束 ===",
  ].join("\n");
}
