import { Effect, Layer } from "effect";
import {
  generateGo,
  generatePython,
  generateSwift,
  generateTypescript,
  introspect,
  sortGeneratorMetadata,
  type Queryable,
} from "@supabase/postgrest-typegen";

import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { oxfmtTypegenFormat } from "./types.oxfmt.ts";
import { GenTypesGenerationError, GenTypesGenerator } from "./types.generator.service.ts";

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
      generate: (input) =>
        Effect.gen(function* () {
          const session = yield* dbConn.connect(input.conn, {
            isLocal: input.isLocal,
            dnsResolver: input.dnsResolver,
          });
          // `session.query` needs no services, but running it through the current fiber's
          // context (rather than a bare detached `Effect.runPromise`) keeps the Promise bridge
          // anchored to this generator effect instead of a disconnected top-level runtime.
          const runQuery = Effect.runPromiseWith(yield* Effect.context<never>());
          const queryable: Queryable = {
            query: (sql) => runQuery(session.query(sql)).then((rows) => ({ rows: [...rows] })),
          };
          return yield* Effect.tryPromise({
            try: async () => {
              const metadata = sortGeneratorMetadata(
                await introspect(queryable, { includedSchemas: [...input.includedSchemas] }),
              );
              switch (input.lang) {
                case "typescript":
                  return await generateTypescript(metadata, {
                    detectOneToOneRelationships: input.detectOneToOneRelationships,
                    format: oxfmtTypegenFormat,
                  });
                case "go":
                  return generateGo(metadata);
                case "python":
                  return generatePython(metadata);
                case "swift":
                  return generateSwift(metadata, { accessControl: input.swiftAccessControl });
              }
            },
            catch: (cause) =>
              new GenTypesGenerationError({
                message: `failed to generate ${input.lang} types: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
                cause,
              }),
          }).pipe(Effect.map(withTrailingNewline));
        }),
    });
  }),
);
