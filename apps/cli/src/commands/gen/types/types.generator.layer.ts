import { Effect, Layer } from "effect";
import {
  generateGo,
  generatePython,
  generateSwift,
  generateTypescript,
  introspect,
  sortGeneratorMetadata,
  type GeneratorMetadata,
  type Queryable,
} from "@supabase/postgrest-typegen";

import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import {
  type GenTypesGenerateInput,
  GenTypesGenerationError,
  GenTypesGenerator,
} from "./types.generator.service.ts";

/**
 * pg-meta printed generated output through `console.log`, which appends a newline regardless of
 * what the generator already emitted — the TypeScript generator ends with one, so its output
 * gained a blank final line. Appending unconditionally keeps every language byte-identical.
 */
function withTrailingNewline(code: string): string {
  return `${code}\n`;
}

/**
 * Live `GenTypesGenerator`: opens a `DbConnection` session, adapts it to the generator's
 * `Queryable` contract, and runs introspection and code generation in-process, replacing the
 * pg-meta Docker container `gen types` previously shelled out to.
 */
export const genTypesGeneratorLayer = Layer.effect(
  GenTypesGenerator,
  Effect.gen(function* () {
    const dbConn = yield* DbConnection;
    return GenTypesGenerator.of({
      generate: Effect.fn("gen.types.generate")(function* (input: GenTypesGenerateInput) {
        const session = yield* dbConn.connect(input.conn, {
          isLocal: input.isLocal,
          dnsResolver: input.dnsResolver,
        });
        // `session.query` needs no services, but running it through the current fiber's
        // context (rather than a bare detached `Effect.runPromise`) keeps the Promise bridge
        // anchored to this generator effect instead of a disconnected top-level runtime.
        const runQuery = Effect.runPromiseWith(yield* Effect.context<never>());
        const toGenerationError = (cause: unknown) =>
          new GenTypesGenerationError({
            message: `failed to generate ${input.lang} types: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            cause,
          });
        const generateSource = (metadata: GeneratorMetadata) => {
          switch (input.lang) {
            case "typescript":
              return Effect.tryPromise({
                try: () =>
                  generateTypescript(metadata, {
                    detectOneToOneRelationships: input.detectOneToOneRelationships,
                    // TypeScript is emitted as the generator wrote it. oxfmt is not bundled.
                    format: (code) => Promise.resolve(code),
                  }),
                catch: toGenerationError,
              });
            case "go":
              return Effect.try({ try: () => generateGo(metadata), catch: toGenerationError });
            case "python":
              return Effect.try({
                try: () => generatePython(metadata),
                catch: toGenerationError,
              });
            case "swift":
              return Effect.try({
                try: () => generateSwift(metadata, { accessControl: input.swiftAccessControl }),
                catch: toGenerationError,
              });
          }
        };
        const metadata = yield* Effect.tryPromise({
          try: (signal) => {
            // `signal` aborts when this generate call is interrupted, so forwarding it to
            // every `runQuery` stops an in-flight introspection query instead of leaving it
            // detached from the fiber that started it.
            const queryable: Queryable = {
              query: (sql) =>
                runQuery(session.query(sql), { signal }).then((rows) => ({ rows: [...rows] })),
            };
            return introspect(queryable, { includedSchemas: [...input.includedSchemas] });
          },
          catch: toGenerationError,
        }).pipe(
          Effect.flatMap((raw) =>
            Effect.try({ try: () => sortGeneratorMetadata(raw), catch: toGenerationError }),
          ),
        );
        return withTrailingNewline(yield* generateSource(metadata));
      }),
    });
  }),
);
