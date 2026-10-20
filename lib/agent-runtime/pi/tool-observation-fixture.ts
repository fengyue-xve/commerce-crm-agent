import type * as FauxProviderModule from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentRuntime } from "../types";
import { PiAgentRuntime } from "./runtime";
import { importNativeEsm, isTsxWorker } from "./native-import";

/** Scripted provider only: the SDK and tool loop are real; no model request. */
export async function createToolObservationDemoRuntime(
  toolName: string,
  args: Record<string, string>,
  render: (observedContent: string) => string,
): Promise<AgentRuntime> {
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = isTsxWorker()
    ? await importNativeEsm<typeof FauxProviderModule>(
        "@earendil-works/pi-ai/providers/faux",
      )
    : await import("@earendil-works/pi-ai/providers/faux");
  const faux = fauxProvider({
    provider: "portfolio-faux",
    models: [{ id: "fulfillment-scripted" }],
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(toolName, args), { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages
        .filter((m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult")
        .at(-1);
      if (!result || result.toolName !== toolName) throw new Error("observed_evidence_required");
      const content = result.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      return fauxAssistantMessage(render(content));
    },
  ]);
  return new PiAgentRuntime(() => ({
    model: faux.getModel() as never,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
  }));
}
