import { Effect, Option } from "effect";
import { generateSchema } from "../../../../shared/schema/generate-schema.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { LegacySchemaGenerateFlags } from "./generate.command.ts";

export const legacySchemaGenerate = Effect.fn("legacy.schema.generate")(function* (
  flags: LegacySchemaGenerateFlags,
) {
  const result = yield* generateSchema({
    name: Option.getOrUndefined(flags.name),
    dryRun: flags.dryRun,
    baseline: flags.baseline,
  });
  yield* renderSchemaResult("Generate schema migrations", result);
});
