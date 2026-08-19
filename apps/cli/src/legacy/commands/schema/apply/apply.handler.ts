import { Effect, Option } from "effect";
import { applySchema } from "../../../../shared/schema/apply-schema.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { LegacySchemaApplyFlags } from "./apply.command.ts";

export const legacySchemaApply = Effect.fn("legacy.schema.apply")(function* (
  flags: LegacySchemaApplyFlags,
) {
  const result = yield* applySchema({
    yes: flags.yes,
    allowDataLoss: flags.allowDataLoss,
    projectRef: Option.getOrUndefined(flags.projectRef),
    allowRemote: flags.allowRemote,
  });
  yield* renderSchemaResult("Apply declarative schema", result);
});
