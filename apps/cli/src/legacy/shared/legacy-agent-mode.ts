import { Option } from "effect";

/** Agent-mode resolution: `yes`→true, `no`→false, `auto`→agent detected. */
export function legacyResolveAgentMode(
  agentFlag: "auto" | "yes" | "no",
  aiToolName: Option.Option<string>,
): boolean {
  if (agentFlag === "yes") return true;
  if (agentFlag === "no") return false;
  return Option.isSome(aiToolName);
}
