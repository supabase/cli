import { Effect, Option } from "effect";
import { applySchema } from "../../../../shared/schema/apply-schema.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { SchemaApplyFlags } from "./apply.command.ts";

export const schemaApply = Effect.fn("schema.apply")(function* (flags: SchemaApplyFlags) {
  const result = yield* applySchema({
    yes: flags.yes,
    allowDataLoss: flags.allowDataLoss,
    projectRef: Option.getOrUndefined(flags.projectRef),
    allowRemote: flags.allowRemote,
  });
  yield* renderSchemaResult("Apply declarative schema", result);
});
