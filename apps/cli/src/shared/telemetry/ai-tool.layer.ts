import { determineAgent, type AgentResult } from "@vercel/detect-agent";
import { Effect, Layer, Option } from "effect";
import { AiTool } from "./ai-tool.service.ts";

function normalizeAgentName(name: string): string {
  return name.replace(/-/g, "_");
}

export const makeAiToolLayer = (detect: () => Promise<AgentResult> = determineAgent) =>
  Layer.effect(
    AiTool,
    Effect.promise(detect).pipe(
      Effect.map((result) =>
        AiTool.of({
          name: result.isAgent ? Option.some(normalizeAgentName(result.agent.name)) : Option.none(),
        }),
      ),
      Effect.orElseSucceed(() => AiTool.of({ name: Option.none() })),
    ),
  );

export const aiToolLayer = makeAiToolLayer();
