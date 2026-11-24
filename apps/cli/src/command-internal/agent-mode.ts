import { Effect, Option } from "effect";

import { AiTool } from "../shared/telemetry/ai-tool.service.ts";
import { AgentFlag } from "./global-flags.ts";

/** Agent-mode resolution: `yes`→true, `no`→false, `auto`→agent detected. */
export function resolveAgentMode(
  agentFlag: "auto" | "yes" | "no",
  aiToolName: Option.Option<string>,
): boolean {
  if (agentFlag === "yes") return true;
  if (agentFlag === "no") return false;
  return Option.isSome(aiToolName);
}

/** Whether `--agent` or a detected AI tool marks this run as driven by a coding agent. */
export const agentDetected = Effect.gen(function* () {
  const flag = Option.getOrElse(yield* Effect.serviceOption(AgentFlag), () => "auto" as const);
  const tool = yield* Effect.serviceOption(AiTool);
  return resolveAgentMode(
    flag,
    Option.flatMap(tool, (detected) => detected.name),
  );
});
