import { Effect, Option } from "effect";
import { pullSchema } from "../../../../shared/schema/pull-schema.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { LegacySchemaPullFlags } from "./pull.command.ts";

export const legacySchemaPull = Effect.fn("legacy.schema.pull")(function* (
  flags: LegacySchemaPullFlags,
) {
  const result = yield* pullSchema({
    from: flags.from,
    output: Option.getOrUndefined(flags.output),
    force: flags.force,
    pruneUnmanaged: flags.pruneUnmanaged,
  });
  yield* renderSchemaResult("Pull declarative schema", result);
});
