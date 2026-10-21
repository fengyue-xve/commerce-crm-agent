// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupplyChainReader } from "./supply-chain-reader";

const ORGANIZATION = "portfolio-org";
const SKU = "AUD-001";
const TOKEN = "synthetic-viewer-jwt-do-not-return";
const AUTH = "/api/auth/login";
const STOCK = "/api/agent/tools/query-stock-level";
const REPLENISH = "/api/agent/tools/suggest-replenish";
const FORM = "/api/forms/records/R-1001";
type ResponseFixture = {
  status?: number;
  value?: unknown;
  raw?: string;
  location?: string;
  beforeResponse?: () => void;
};
type Received = { method: string; path: string; authorization?: string; body: unknown };
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

async function service(overrides: Record<string, ResponseFixture> = {}) {
  const received: Received[] = [];
  const responses: Record<string, ResponseFixture> = {
    [AUTH]: { value: { code: 0, data: { token: TOKEN, password: "private-response-marker" } } },
    [STOCK]: {
      value: {
        code: 0,
        data: {
          items: [
            {
              sku: SKU,
              availableQty: 18,
              snapDate: "2026-09-03",
              internalNote: "private-response-marker",
            },
          ],
        },
      },
    },
    [REPLENISH]: {
      value: {
        code: 0,
        data: { items: [{ sku: SKU, suggestedQty: 72, assessmentStatus: "reference" }] },
      },
    },
    [FORM]: {
      value: {
        code: 0,
        data: {
          record_id: "R-1001",
          sku_code: SKU,
          business_version: 3,
          outer_box_mark: { value: "SYNTHETIC-BOX" },
          internalNote: "private-response-marker",
        },
      },
    },
    ...overrides,
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    received.push({
      method: request.method ?? "",
      path: request.url ?? "",
      authorization: request.headers.authorization,
      body: raw ? (JSON.parse(raw) as unknown) : null,
    });
    const fixture = responses[request.url ?? ""];
    if (!fixture) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end('{"error":"unexpected-path"}');
      return;
    }
    fixture.beforeResponse?.();
    response.writeHead(fixture.status ?? 200, {
      "Content-Type": "application/json",
      ...(fixture.location ? { Location: fixture.location } : {}),
    });
    response.end(fixture.raw ?? JSON.stringify(fixture.value));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_receiver_not_listening");
  const config = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    username: "viewer",
    password: "synthetic-viewer-password",
    organizationId: ORGANIZATION,
    recordBySku: { [SKU]: "R-1001" },
  };
  return { received, config, reader: new SupplyChainReader(config) };
}

describe("supply-chain read adapter against an actual local HTTP receiver", () => {
  it("authenticates the viewer and calls only the three fixed read operations", async () => {
    const startedAt = "2026-10-21T01:00:00.000Z";
    const completedAt = "2026-10-21T01:00:09.000Z";
    const failedAt = "2026-10-21T01:00:12.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(startedAt));
    // Real HTTP remains asynchronous; only the clock advances at a response boundary.
    const fixture = await service({
      [STOCK]: {
        value: {
          code: 0,
          data: { items: [{ sku: SKU, availableQty: 18, snapDate: "2026-09-03" }] },
        },
        beforeResponse: () => vi.setSystemTime(new Date(completedAt)),
      },
    });
    const receipt = await fixture.reader.read(SKU, ORGANIZATION);
    expect(receipt.receivedAt).toBe(completedAt);
    expect(receipt.evidence.collected_at).toBe(completedAt);
    const denied = await service({
      [AUTH]: {
        status: 401,
        value: { error: "denied" },
        beforeResponse: () => vi.setSystemTime(new Date(failedAt)),
      },
    });
    const failedReceipt = await denied.reader.read(SKU, ORGANIZATION);
    expect(failedReceipt.receivedAt).toBe(failedAt);
    expect(failedReceipt.evidence.collected_at).toBe(failedAt);
    expect(fixture.received).toHaveLength(4);
    expect(fixture.received[0]?.path).toBe(AUTH);
    expect(fixture.received.map(({ method, path }) => ({ method, path }))).toEqual(
      expect.arrayContaining([
        { method: "POST", path: AUTH },
        { method: "POST", path: STOCK },
        { method: "POST", path: REPLENISH },
        { method: "GET", path: FORM },
      ]),
    );
    expect(fixture.received[0]).toMatchObject({
      body: { username: "viewer", password: "synthetic-viewer-password" },
    });
    expect(fixture.received[0]?.authorization).toBeUndefined();
    for (const received of fixture.received.slice(1))
      expect(received.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fixture.received.find((request) => request.path === STOCK)?.body).toEqual({
      skus: [SKU],
    });
    expect(fixture.received.find((request) => request.path === REPLENISH)?.body).toEqual({
      skus: [SKU],
      days: 7,
      targetCoverDays: 14,
    });
    expect(receipt.failures).toEqual([]);
    expect(receipt.evidence.stock?.quantity).toBe(18);
    expect(receipt.evidence.replenishment?.suggested_qty).toBe(72);
    expect(receipt.evidence.preparation).toMatchObject({
      record_id: "R-1001",
      business_version: 3,
      outer_box_mark_present: true,
    });
    expect(receipt.evidence.purchases).toEqual([]);
    expect(receipt.requests.every((request) => request.status === 200)).toBe(true);
    const publicReceipt = JSON.stringify(receipt);
    expect(publicReceipt).not.toMatch(
      /synthetic-viewer-jwt|synthetic-viewer-password|private-response-marker|SYNTHETIC-BOX/,
    );
    expect(
      fixture.received.every(
        (request) => !/purchase|confirm|approve|send|apply|replay/.test(request.path),
      ),
    ).toBe(true);
  });

  it("refuses a different organization before authentication or any network request", async () => {
    const fixture = await service();
    await expect(fixture.reader.read(SKU, "other-organization")).rejects.toThrow(
      "reader_scope_mismatch",
    );
    expect(fixture.received).toEqual([]);
  });

  it.each([
    "AUD-001/../../api/purchase",
    "AUD-001?url=http://evil.invalid",
    "aud-001",
    "AUD-001\nX: y",
  ])("rejects path injection SKU %s before network", async (sku) => {
    const fixture = await service();
    await expect(fixture.reader.read(sku, ORGANIZATION)).rejects.toThrow();
    expect(fixture.received).toEqual([]);
  });

  it.each([
    "https://127.0.0.1:1234",
    "http://example.invalid:1234",
    "http://127.0.0.1:1234/api",
    "http://user:password@127.0.0.1:1234",
    "http://127.0.0.1:1234/?url=other",
    "http://127.0.0.1:1234/#other",
  ])("requires an explicit local root origin: %s", (baseUrl) => {
    expect(
      () =>
        new SupplyChainReader({
          baseUrl,
          organizationId: ORGANIZATION,
          username: "viewer",
          password: "fixture",
        }),
    ).toThrow("local_supply_origin_required");
  });

  it("rejects an injected form record mapping at configuration time", async () => {
    const fixture = await service();
    expect(
      () =>
        new SupplyChainReader({
          ...fixture.config,
          recordBySku: { [SKU]: "R-1001/../../purchase" },
        }),
    ).toThrow();
    expect(fixture.received).toEqual([]);
  });

  it("does not turn an authentication 401 into empty-stock or other successful facts", async () => {
    const fixture = await service({ [AUTH]: { status: 401, value: { error: "denied" } } });
    const receipt = await fixture.reader.read(SKU, ORGANIZATION);
    expect(fixture.received.map((request) => request.path)).toEqual([AUTH]);
    expect(receipt.evidence).toMatchObject({
      stock: null,
      replenishment: null,
      preparation: null,
      purchases: [],
    });
    expect(receipt.failures).toEqual([
      "stock_unavailable",
      "replenishment_unavailable",
      "preparation_unavailable",
    ]);
    expect(receipt.requests).toEqual([{ method: "POST", path: AUTH, status: 401 }]);
  });

  it("retains valid preparation when stock is unauthorized and replenishment is unavailable", async () => {
    const fixture = await service({
      [STOCK]: { status: 401, value: {} },
      [REPLENISH]: { status: 503, value: {} },
    });
    const receipt = await fixture.reader.read(SKU, ORGANIZATION);
    expect(receipt.evidence.stock).toBeNull();
    expect(receipt.evidence.replenishment).toBeNull();
    expect(receipt.evidence.preparation?.record_id).toBe("R-1001");
    expect(receipt.failures).toEqual(["stock_unavailable", "replenishment_unavailable"]);
    expect(receipt.requests.find((request) => request.path === STOCK)?.status).toBe(401);
    expect(receipt.requests.find((request) => request.path === REPLENISH)?.status).toBe(503);
  });

  it("does not invent zero stock from malformed JSON and preserves the other sources", async () => {
    const fixture = await service({ [STOCK]: { raw: "{not JSON" } });
    const receipt = await fixture.reader.read(SKU, ORGANIZATION);
    expect(receipt.evidence.stock).toBeNull();
    expect(receipt.evidence.replenishment?.suggested_qty).toBe(72);
    expect(receipt.evidence.preparation?.outer_box_mark_present).toBe(true);
    expect(receipt.failures).toEqual(["stock_unavailable"]);
  });

  it("discards invalid-date stock while retaining independently valid source facts", async () => {
    const fixture = await service({
      [STOCK]: {
        value: {
          code: 0,
          data: { items: [{ sku: SKU, availableQty: 18, snapDate: "2026-02-30" }] },
        },
      },
    });
    const receipt = await fixture.reader.read(SKU, ORGANIZATION);
    expect(receipt.evidence.stock).toBeNull();
    expect(receipt.evidence.replenishment?.suggested_qty).toBe(72);
    expect(receipt.evidence.preparation?.record_id).toBe("R-1001");
    expect(receipt.failures).toEqual(["stock_unavailable"]);
  });

  it("does not relabel foreign-SKU results or another form record as this product's facts", async () => {
    const fixture = await service({
      [STOCK]: {
        value: {
          code: 0,
          data: { items: [{ sku: "CHG-001", availableQty: 999, snapDate: "2026-09-03" }] },
        },
      },
      [REPLENISH]: {
        value: {
          code: 0,
          data: { items: [{ sku: "CHG-001", suggestedQty: 999, assessmentStatus: "ready" }] },
        },
      },
      [FORM]: {
        value: {
          code: 0,
          data: {
            record_id: "R-9999",
            sku_code: SKU,
            business_version: 9,
            outer_box_mark: { value: "box" },
          },
        },
      },
    });
    const receipt = await fixture.reader.read(SKU, ORGANIZATION);
    expect(receipt.evidence).toMatchObject({ stock: null, replenishment: null, preparation: null });
    expect(receipt.failures).toEqual([
      "stock_unavailable",
      "replenishment_unavailable",
      "preparation_unavailable",
    ]);
    expect(JSON.stringify(receipt)).not.toMatch(/CHG-001|R-9999/);
  });

  it("does not follow a redirect into an unauthorized operation", async () => {
    const fixture = await service({
      [STOCK]: { status: 302, location: "/api/purchase/confirm", value: {} },
    });
    const receipt = await fixture.reader.read(SKU, ORGANIZATION);
    expect(receipt.evidence.stock).toBeNull();
    expect(receipt.failures).toContain("stock_unavailable");
    expect(fixture.received.some((request) => request.path === "/api/purchase/confirm")).toBe(
      false,
    );
    expect(receipt.evidence.preparation).not.toBeNull();
  });

  it("keeps an explicit missing preparation state when no SKU mapping is configured", async () => {
    const fixture = await service();
    const reader = new SupplyChainReader({ ...fixture.config, recordBySku: {} });
    const receipt = await reader.read(SKU, ORGANIZATION);
    expect(receipt.evidence.preparation).toBeNull();
    expect(receipt.failures).toEqual(["preparation_unavailable"]);
    expect(fixture.received).toHaveLength(3);
    expect(fixture.received.map((request) => request.path)).toEqual(
      expect.arrayContaining([AUTH, STOCK, REPLENISH]),
    );
  });
});
