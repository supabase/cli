import { Effect, Option } from "effect";

import { CommandTarget } from "../../shared/output/command-target.service.ts";
import { configIsRecord } from "./config.paths.ts";

/** Puts the announced target's identity fields (`kind`, `project_name`, `environment`, …) in front of the payload's own `target` fields, which win on a clash. */
export const configPayloadWithTargetIdentity = Effect.fnUntraced(function* (
  payload: Record<string, unknown>,
) {
  const announced = yield* CommandTarget.use((cell) => cell.json);
  if (Option.isNone(announced)) return payload;
  const own = configIsRecord(payload["target"]) ? payload["target"] : {};
  return { ...payload, target: { ...announced.value, ...own } };
});
