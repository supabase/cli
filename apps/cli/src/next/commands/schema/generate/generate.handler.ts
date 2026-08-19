import { Effect, Option } from "effect";
import { generateSchema } from "../../../../shared/schema/generate-schema.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { SchemaGenerateFlags } from "./generate.command.ts";

export const schemaGenerate = Effect.fn("schema.generate")(function* (flags: SchemaGenerateFlags) {
  const result = yield* generateSchema({
    name: Option.getOrUndefined(flags.name),
    dryRun: flags.dryRun,
    baseline: flags.baseline,
  });
  yield* renderSchemaResult("Generate schema migrations", result);
});
