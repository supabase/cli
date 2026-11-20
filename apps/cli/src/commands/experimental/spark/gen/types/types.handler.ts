import { Effect, Option } from "effect";

import { Output } from "../../../../../shared/output/output.service.ts";
import { sparkTypescriptTypes } from "../../spark-api.ts";
import { withLinkedProject } from "../../spark.shared.ts";

/** `supabase gen types typescript`: the project's TypeScript types, on stdout. */
export const sparkGenTypes = Effect.fn("spark.gen.types")(function* (flags: {
  readonly projectRef: Option.Option<string>;
  readonly schema: ReadonlyArray<string>;
}) {
  yield* withLinkedProject(flags.projectRef, (ref) =>
    Effect.gen(function* () {
      const output = yield* Output;
      yield* output.raw(yield* sparkTypescriptTypes(ref, flags.schema));
    }),
  );
});
