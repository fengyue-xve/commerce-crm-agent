// @vitest-environment node
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { generateAgentDraft } from "./agent";
import { loadAgentConfig } from "./agent-config";

it("executes the real Pi compatible HTTP provider, observations and correction feedback", async () => {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }> = [];
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(chunk as Buffer);
    requests.push(JSON.parse(Buffer.concat(buffers).toString()));
    const index = requests.length;
    const tools = ["read_stock", "read_replenishment", "read_preparation"];
    const tool = tools[index - 1];
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `read-${index}`, type: "function", function: { name: tool, arguments: '{"sku":"AUD-001"}' } }] } :
      { role: "assistant", content: JSON.stringify(index === 4 ? { reply: "保证明天发货，库存999件", claims: [] } : { reply: "历史库存18件，交期需要核实。", claims: [{ kind: "stock", quantity: 18 }] }) };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "synthetic-http", object: "chat.completion.chunk", model: "synthetic-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(event(delta, null) + event({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const config = loadAgentConfig({ PORTFOLIO_LLM_ENGINE: "openai-compatible", PORTFOLIO_LLM_API_KEY: "synthetic-no-external-network", PORTFOLIO_LLM_MODEL: "synthetic-model",
      PORTFOLIO_LLM_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
    const result = await generateAgentDraft({ organizationId: "demo-org", sku: "AUD-001", mode: "historical_replay", config,
      reader: async () => ({ evidence: { schema_version: 1, organization_id: "demo-org", sku: "AUD-001", collected_at: new Date().toISOString(), source_kind: "supply_chain_http",
        stock: { sku: "AUD-001", quantity: 18, snapshot_date: "2026-09-03" }, replenishment: null, preparation: null, purchases: [] }, receivedAt: new Date().toISOString(), failures: [], requests: [] }) });
    expect(result.provider).toBe("openai-compatible");
    expect(requests).toHaveLength(5);
    expect(requests[1]!.messages.some((message) => message.role === "tool")).toBe(true);
    expect(JSON.stringify(requests[4])).toContain("shipment_promise_forbidden");
    expect(result.guardrail.corrections).toBe(1); expect(result.guardrail.status).toBe("passed");
    expect(result.draft).toContain("18件"); expect(result.draft).not.toContain("999");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 15_000);
