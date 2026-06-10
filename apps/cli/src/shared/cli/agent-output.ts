import { Option } from "effect";
import type { OutputFormat } from "../output/types.ts";

export function resolveAgentOutputFormat(
  explicit: Option.Option<OutputFormat>,
  isCodingAgent: boolean,
): OutputFormat {
  return Option.getOrElse(explicit, () => (isCodingAgent ? "json" : "text"));
}
