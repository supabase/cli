import { Effect } from "effect";

import { Output } from "../../../../../shared/output/output.service.ts";
import type { TargetFlagValues } from "../../../../../command-internal/target/target-flags.ts";
import { SparkTarget, withSparkTarget } from "../../spark-target.ts";

/** `supabase gen types typescript`: the project's TypeScript types, on stdout. */
export const sparkGenTypes = Effect.fn("spark.gen.types")(function* (
  flags: TargetFlagValues & { readonly schema: ReadonlyArray<string> },
) {
  yield* withSparkTarget(flags, () =>
    Effect.gen(function* () {
      const output = yield* Output;
      const spark = yield* SparkTarget;
      yield* output.raw(yield* spark.typescriptTypes(flags.schema));
    }),
  );
});
