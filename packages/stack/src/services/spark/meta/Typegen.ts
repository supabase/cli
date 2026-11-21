import { findLanguage, sparkGeneratorMetadata, type Host } from "@supabase/typegen";
import { Data, Effect } from "effect";

import type { Description } from "./Description.ts";

export class SparkTypegenError extends Data.TaggedError("SparkTypegenError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Unformatted like `supabase gen types`, which keeps `oxfmt` out of the bundle; no generator spawns.
const host: Host = { cwd: ".", env: {}, format: (code) => Promise.resolve(code) };

/** TypeScript types for `schemas`, from the generator `supabase gen types` and postgres-meta use. */
export const typescript = Effect.fn("SparkMeta.typescript")(function* (
  description: Description,
  schemas: ReadonlyArray<string>,
) {
  const language = findLanguage("typescript");
  if (language === undefined)
    return yield* new SparkTypegenError({ message: "@supabase/typegen has no typescript" });
  return yield* Effect.tryPromise({
    try: (signal) =>
      language.generate(sparkGeneratorMetadata(description, { schemas }), {}, { ...host, signal }),
    catch: (cause) =>
      new SparkTypegenError({
        message: `failed to generate typescript types: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
});
