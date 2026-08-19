import { Effect, Option } from "effect";
import { pullSchema } from "../../../../shared/schema/pull-schema.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { SchemaPullFlags } from "./pull.command.ts";

export const schemaPull = Effect.fn("schema.pull")(function* (flags: SchemaPullFlags) {
  const result = yield* pullSchema({
    from: Option.getOrUndefined(flags.from),
    output: Option.getOrUndefined(flags.output),
    force: flags.force,
    pruneUnmanaged: flags.pruneUnmanaged,
  });
  yield* renderSchemaResult("Pull declarative schema", result);
});
