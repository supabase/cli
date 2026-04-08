import { determineAgent } from "@vercel/detect-agent";
import { Effect, Layer, Option } from "effect";
import { AiTool } from "./ai-tool.service.ts";

function normalizeAgentName(name: string): string {
  return name.replace(/-/g, "_");
}

export const aiToolLayer = Layer.effect(
  AiTool,
  Effect.promise(() => determineAgent()).pipe(
    Effect.map((result) =>
      AiTool.of({
        name: result.isAgent ? Option.some(normalizeAgentName(result.agent.name)) : Option.none(),
      }),
    ),
    Effect.catch(() =>
      Effect.succeed(
        AiTool.of({
          name: Option.none(),
        }),
      ),
    ),
  ),
);
