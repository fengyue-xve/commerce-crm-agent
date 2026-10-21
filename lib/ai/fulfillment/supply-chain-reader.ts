import { z } from "zod";
import { operationalEvidenceSchema, type OperationalEvidence } from "./evidence";

const skuSchema = z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,31}$/);
const recordSchema = z.string().regex(/^R-[0-9]{4}$/);
export interface SupplyReaderConfig {
  baseUrl: string;
  username: string;
  password: string;
  organizationId: string;
  recordBySku?: Readonly<Record<string, string>>;
}
export interface ReadReceipt {
  evidence: OperationalEvidence;
  failures: Array<"stock_unavailable" | "replenishment_unavailable" | "preparation_unavailable">;
  receivedAt: string;
  requests: Array<{ method: "POST" | "GET"; path: string; status: number | null }>;
}

/** Local synthetic service only; this is not a tenant identity mapping to a production ERP. */
export class SupplyChainReader {
  private readonly base: string;
  constructor(private readonly config: SupplyReaderConfig) {
    const url = new URL(config.baseUrl);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("local_supply_origin_required");
    }
    if (!config.organizationId || !config.username || !config.password)
      throw new Error("reader_config_incomplete");
    this.base = url.origin;
    for (const [sku, id] of Object.entries(config.recordBySku ?? {})) {
      skuSchema.parse(sku);
      recordSchema.parse(id);
    }
  }

  async read(sku: string, organizationId: string): Promise<ReadReceipt> {
    skuSchema.parse(sku);
    if (organizationId !== this.config.organizationId) throw new Error("reader_scope_mismatch");
    const requests: ReadReceipt["requests"] = [];
    const call = async (path: string, body?: unknown, token?: string): Promise<unknown> => {
      const receipt: ReadReceipt["requests"][number] = {
        method: body === undefined ? "GET" : "POST",
        path,
        status: null,
      };
      requests.push(receipt);
      const response = await fetch(this.base + path, {
        method: receipt.method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      receipt.status = response.status;
      if (!response.ok) throw new Error("supply_read_unavailable");
      const text = await response.text();
      if (text.length > 262144) throw new Error("supply_response_too_large");
      return JSON.parse(text) as unknown;
    };
    const emptyEvidence = (receivedAt: string): OperationalEvidence => operationalEvidenceSchema.parse({
      schema_version: 1,
      organization_id: organizationId,
      sku,
      collected_at: receivedAt,
      source_kind: "supply_chain_http",
      stock: null,
      replenishment: null,
      preparation: null,
      purchases: [],
    });
    let token: string;
    try {
      const login = z
        .object({ code: z.literal(0), data: z.object({ token: z.string().min(1) }) })
        .parse(
          await call("/api/auth/login", {
            username: this.config.username,
            password: this.config.password,
          }),
        );
      token = login.data.token;
    } catch {
      const receivedAt = new Date().toISOString();
      return {
        evidence: emptyEvidence(receivedAt),
        receivedAt,
        requests,
        failures: ["stock_unavailable", "replenishment_unavailable", "preparation_unavailable"],
      };
    }
    const stockSchema = z.object({
      code: z.literal(0),
      data: z.object({
        items: z.array(
          z.object({
            sku: skuSchema,
            availableQty: z.number().int().nonnegative(),
            snapDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .refine((value) => {
                const date = new Date(value + "T00:00:00.000Z");
                return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
              }),
          }),
        ),
      }),
    });
    const replenishSchema = z.object({
      code: z.literal(0),
      data: z.object({
        items: z.array(
          z.object({
            sku: skuSchema,
            suggestedQty: z.number().int().nonnegative().nullable(),
            assessmentStatus: z.enum([
              "ready",
              "reference",
              "review_required",
              "insufficient_data",
            ]),
          }),
        ),
      }),
    });
    const formSchema = z.object({
      code: z.literal(0),
      data: z.object({
        record_id: recordSchema,
        sku_code: skuSchema,
        business_version: z.number().int().positive(),
        outer_box_mark: z.object({ value: z.string().nullable().optional() }).nullable().optional(),
      }),
    });
    const record = this.config.recordBySku?.[sku];
    const results = await Promise.allSettled([
      call("/api/agent/tools/query-stock-level", { skus: [sku] }, token).then((x) =>
        stockSchema.parse(x),
      ),
      call(
        "/api/agent/tools/suggest-replenish",
        { skus: [sku], days: 7, targetCoverDays: 14 },
        token,
      ).then((x) => replenishSchema.parse(x)),
      record
        ? call("/api/forms/records/" + record, undefined, token).then((x) => formSchema.parse(x))
        : Promise.resolve(null),
    ]);
    // Stamp collection after every HTTP response has settled, including partial failures.
    const receivedAt = new Date().toISOString();
    const empty = emptyEvidence(receivedAt);
    const failures: ReadReceipt["failures"] = [];
    const stock = results[0];
    if (stock?.status === "fulfilled") {
      const row = stock.value.data.items.find((x) => x.sku === sku);
      if (row)
        empty.stock = { sku: row.sku, quantity: row.availableQty, snapshot_date: row.snapDate };
      else failures.push("stock_unavailable");
    } else failures.push("stock_unavailable");
    const replenishment = results[1];
    if (replenishment?.status === "fulfilled") {
      const row = replenishment.value.data.items.find((x) => x.sku === sku);
      if (row)
        empty.replenishment = {
          sku: row.sku,
          suggested_qty: row.suggestedQty,
          assessment_status: row.assessmentStatus,
        };
      else failures.push("replenishment_unavailable");
    } else failures.push("replenishment_unavailable");
    const preparation = results[2];
    if (preparation?.status === "fulfilled" && preparation.value) {
      const row = preparation.value.data;
      // A SKU match is only a cross-check, never an order/customer fulfillment link.
      if (row.sku_code === sku && row.record_id === record)
        empty.preparation = {
          record_id: row.record_id,
          sku: row.sku_code,
          business_version: row.business_version,
          outer_box_mark_present: Boolean(row.outer_box_mark?.value?.trim()),
        };
      else failures.push("preparation_unavailable");
    } else failures.push("preparation_unavailable");
    const valid = operationalEvidenceSchema.safeParse(empty);
    return {
      evidence: valid.success
        ? valid.data
        : { ...empty, stock: null, replenishment: null, preparation: null },
      receivedAt,
      requests,
      failures: valid.success
        ? failures
        : ["stock_unavailable", "replenishment_unavailable", "preparation_unavailable"],
    };
  }
}
