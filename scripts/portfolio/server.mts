import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { SupplyChainReader } from "../../lib/ai/fulfillment/supply-chain-reader";
import { generateOperationalDraft, type DraftResult } from "../../lib/ai/fulfillment/draft";

const root = process.cwd();
const arg = process.argv.indexOf("--config");
const configPath =
  arg < 0 ? "examples/fulfillment-demo/config.example.json" : process.argv[arg + 1];
if (!configPath) throw new Error("config_path_required");
const config = z
  .strictObject({
    port: z.number().int().min(1024).max(65535),
    organizationId: z.string().min(1),
    supply: z.strictObject({
      baseUrl: z.url(),
      username: z.string().min(1),
      password: z.string().min(1),
      recordBySku: z.record(z.string(), z.string()),
    }),
  })
  .parse(JSON.parse(await readFile(resolve(root, configPath), "utf8")));
const reader = new SupplyChainReader({ ...config.supply, organizationId: config.organizationId });
const origin = `http://127.0.0.1:${config.port}`;
const drafts = new Map<string, { draft: DraftResult; createdAt: number }>();
let active = false;
const postSchema = z.strictObject({
  sku: z.enum(["AUD-001", "DEM-001"]),
  mode: z.enum(["current_check", "historical_replay"]),
});

const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.headers.host !== `127.0.0.1:${config.port}`) {
      json(403, { error: "local_origin_required" });
      return;
    }
    const path = new URL(req.url ?? "/", origin).pathname;
    if (req.method === "GET" && path === "/api/health") {
      json(200, {
        status: "ok",
        provider: "official-pi-faux",
        scope: "isolated-synthetic-demo",
        sendsAvailable: false,
      });
      return;
    }
    const assets: Record<string, [string, string]> = {
      "/": ["index.html", "text/html"],
      "/app.js": ["app.js", "text/javascript"],
      "/style.css": ["style.css", "text/css"],
    };
    if (req.method === "GET" && assets[path]) {
      const entry = assets[path];
      const body = await readFile(resolve(root, "examples/fulfillment-demo", entry[0]));
      res.writeHead(200, { "Content-Type": entry[1] + "; charset=utf-8" });
      res.end(body);
      return;
    }
    if (req.method !== "POST") {
      json(404, { error: "not_found" });
      return;
    }
    if (
      req.headers.origin !== origin ||
      !req.headers["content-type"]?.startsWith("application/json")
    ) {
      json(403, { error: "same_origin_json_required" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) {
        json(413, { error: "body_too_large" });
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      json(400, { error: "invalid_json" });
      return;
    }
    if (path === "/api/drafts") {
      const parsed = postSchema.safeParse(body);
      if (!parsed.success) {
        json(400, { error: "invalid_request" });
        return;
      }
      if (active) {
        json(429, { error: "one_demo_at_a_time" });
        return;
      }
      active = true;
      try {
        const draft = await generateOperationalDraft({
          ...parsed.data,
          organizationId: config.organizationId,
          reader: (sku, org) => reader.read(sku, org),
        });
        for (const [id, row] of drafts)
          if (Date.now() - row.createdAt > 30 * 60 * 1000) drafts.delete(id);
        if (drafts.size >= 100) drafts.delete(drafts.keys().next().value as string);
        drafts.set(draft.id, { draft, createdAt: Date.now() });
        json(200, draft);
      } finally {
        active = false;
      }
      return;
    }
    const match = /^\/api\/drafts\/([0-9a-f-]{36})\/review$/.exec(path);
    if (match) {
      const parsed = z.strictObject({ revision: z.literal(1) }).safeParse(body);
      if (!parsed.success) {
        json(400, { error: "invalid_review" });
        return;
      }
      const saved = drafts.get(match[1]!);
      if (!saved || Date.now() - saved.createdAt > 30 * 60 * 1000) {
        json(404, { error: "draft_expired" });
        return;
      }
      if (saved.draft.assessment.status === "blocked") {
        json(409, { error: "blocked_draft_cannot_be_reviewed" });
        return;
      }
      saved.draft.reviewed = true;
      json(200, { id: saved.draft.id, reviewed: true, sent: false, crmPersisted: false });
      return;
    }
    json(404, { error: "not_found" });
  } catch (error) {
    // Return a bounded code, never provider context, credentials or upstream bodies.
    process.stderr.write(`Demo request failed: ${error instanceof Error ? error.name : "Error"}\n`);
    if (!res.headersSent)
      json(503, {
        error: "demo_unavailable",
        message: "请检查供应链服务和本地运行日志；没有发送客户消息。",
      });
    else res.end();
  }
});
server.listen(config.port, "127.0.0.1", () =>
  process.stdout.write(
    `Isolated fulfillment demo: ${origin}; actual CRM Pi adapter + scripted Faux; no Supabase, no customer sending.\n`,
  ),
);
