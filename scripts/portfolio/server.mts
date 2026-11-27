import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { SupplyChainReader } from "../../lib/ai/fulfillment/supply-chain-reader";
import { generateAgentDraft } from "../../lib/ai/fulfillment/agent";
import { loadAgentConfig } from "../../lib/ai/fulfillment/agent-config";
import { ProposalStore, ProposalConflict } from "../../lib/ai/fulfillment/proposal-store";

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
const demoMode = process.argv.includes("--demo");
if (demoMode && process.argv.includes("--live")) throw new Error("请选择 --demo 或 --live。");
const settings = {
  portfolio_llm_engine_required: "请设置 PORTFOLIO_LLM_ENGINE 为 openai、deepseek 或 openai-compatible。",
  portfolio_llm_key_required: "请设置 PORTFOLIO_LLM_API_KEY。",
  portfolio_compatible_url_required: "请设置 PORTFOLIO_LLM_BASE_URL。",
  portfolio_llm_origin_invalid: "请为 PORTFOLIO_LLM_BASE_URL 填写有效的服务地址。",
};
function configureAgent() {
  if (demoMode) return loadAgentConfig({ PORTFOLIO_LLM_ENGINE: "faux" });
  try {
    const runtimeConfig = loadAgentConfig();
    if (runtimeConfig.engine !== "faux") return runtimeConfig;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const message = Object.hasOwn(settings, code) ? settings[code as keyof typeof settings] : "请检查 PORTFOLIO_LLM_ENGINE 和 PORTFOLIO_LLM_BASE_URL。";
    throw new Error(message);
  }
  throw new Error("使用脚本模型请以 --demo 启动。");
}
const agentConfig = configureAgent();
const runErrors = {
  portfolio_model_timeout: "模型响应超时，请重试核对。",
  portfolio_model_unavailable: "模型服务暂不可用，请检查模型配置后重试核对。",
  portfolio_source_unavailable: "库存数据暂不可用，请检查供应链服务后重试核对。",
};
const store = new ProposalStore(resolve(root, "output/portfolio/agent-state.json"), config.organizationId);
let active = false;
const postSchema = z.strictObject({
  sku: z.enum(["AUD-001", "DEM-001"]),
  mode: z.enum(["current_check", "historical_replay"]),
  question: z.string().trim().min(1).max(2000).optional(),
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
        mode: demoMode ? "demo" : "live",
        provider: agentConfig.engine === "faux" ? "official-pi-faux" : agentConfig.engine,
        scope: "isolated-synthetic-demo",
        sendsAvailable: false,
        durableProposals: true,
      });
      return;
    }
    if (req.method === "GET" && path === "/api/state") {
      json(200, await store.snapshot());
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
        const before = await store.snapshot();
        const opportunity = before.opportunities.find((row) => row.sku === parsed.data.sku)!;
        const draft = await generateAgentDraft({
          ...parsed.data,
          organizationId: config.organizationId,
          reader: (sku, org, section) => reader.read(sku, org, [section]),
          config: agentConfig,
        });
        if (draft.status === "failed") {
          const error = draft.error ?? "portfolio_model_unavailable";
          json(503, { error, status: draft.status, message: runErrors[error] });
          return;
        }
        // Persistence and every business mutation happen only after the model loop exits.
        const proposals = await store.recordDraft(draft, opportunity.version, before.generation);
        json(200, { ...draft, proposals, demoPersisted: true });
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
      json(200, await store.review(match[1]!, parsed.data.revision));
      return;
    }
    const proposalMatch = /^\/api\/proposals\/([0-9a-f-]{36})\/(execute|approve|undo|reject)$/.exec(path);
    if (proposalMatch) {
      const input = z.strictObject({ revision: z.number().int().positive() }).safeParse(body);
      if (!input.success) { json(400, { error: "invalid_proposal_revision" }); return; }
      if (active) { json(409, { error: "agent_run_active" }); return; }
      json(200, await store.act(proposalMatch[1]!, input.data.revision, proposalMatch[2] as "execute" | "approve" | "undo" | "reject"));
      return;
    }
    if (path === "/api/demo/reset") {
      const input = z.strictObject({ confirmed: z.literal(true), generation: z.number().int().positive() }).safeParse(body);
      if (!input.success) { json(400, { error: "explicit_reset_confirmation_required" }); return; }
      if (active) { json(409, { error: "agent_run_active" }); return; }
      json(200, await store.reset(input.data.generation));
      return;
    }
    json(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof ProposalConflict) { json(409, { error: error.code }); return; }
    // Return a bounded code, never provider context, credentials or upstream bodies.
    process.stderr.write(`Fulfillment request failed: ${error instanceof Error ? error.name : "Error"}\n`);
    if (!res.headersSent)
      json(503, {
        error: "demo_unavailable",
        message: "履约服务暂不可用，请检查本地运行日志后重试。",
      });
    else res.end();
  }
});
server.listen(config.port, "127.0.0.1", () =>
  process.stdout.write(
    `Fulfillment ${demoMode ? "demo" : "live"} at ${origin} (${agentConfig.engine})\n`,
  ),
);
