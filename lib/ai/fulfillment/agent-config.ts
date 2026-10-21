import { z } from "zod";
import type { RuntimeModelBinding } from "@/lib/agent-runtime/types";

export type AgentEngine = "faux" | "openai" | "deepseek" | "openai-compatible";
export interface AgentConfig { engine: AgentEngine; binding: RuntimeModelBinding }

/** Server environment only. This module never reads files or returns keys to the UI. */
export function loadAgentConfig(environment: Readonly<Record<string, string | undefined>> = process.env): AgentConfig {
  const engine = z.enum(["faux", "openai", "deepseek", "openai-compatible"])
    .parse(environment.PORTFOLIO_LLM_ENGINE ?? "faux");
  if (engine === "faux") return { engine, binding: { provider: "portfolio-faux", model: "fulfillment-scripted", apiKey: "synthetic-no-network" } };
  const apiKey = environment.PORTFOLIO_LLM_API_KEY;
  if (!apiKey?.trim()) throw new Error("portfolio_llm_key_required");
  const baseUrl = environment.PORTFOLIO_LLM_BASE_URL || (engine === "openai" ? "https://api.openai.com/v1" : "https://api.deepseek.com");
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
    throw new Error("portfolio_llm_origin_invalid");
  if (engine === "openai-compatible" && !environment.PORTFOLIO_LLM_BASE_URL)
    throw new Error("portfolio_compatible_url_required");
  return { engine, binding: {
    // The existing DeepSeek Pi provider uses the OpenAI chat-completions wire protocol.
    provider: engine === "openai" ? "openai" : "deepseek",
    model: environment.PORTFOLIO_LLM_MODEL || (engine === "openai" ? "gpt-4.1-mini" : "deepseek-chat"),
    apiKey, baseUrl: url.toString().replace(/\/$/, ""), maxOutputTokens: 1800, temperature: 0,
  } };
}
