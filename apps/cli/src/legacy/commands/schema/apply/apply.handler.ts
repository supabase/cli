import { Effect } from "effect";
import { applySchema } from "../../../../shared/schema/apply-schema.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";

export const legacySchemaApply = Effect.fn("legacy.schema.apply")(function* () {
  const result = yield* applySchema();
  yield* renderSchemaResult("Apply declarative schema", result);
});
