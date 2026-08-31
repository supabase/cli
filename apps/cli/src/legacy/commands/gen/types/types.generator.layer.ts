import {
  generateGo,
  generatePython,
  generateSwift,
  generateTypescript,
  sortGeneratorMetadata,
} from "@supabase/postgrest-typegen/generation";
import { introspect } from "@supabase/postgrest-typegen/introspection";
import { Effect, Layer } from "effect";

import { legacyAcquirePgPool } from "../../../shared/legacy-db-connection.sql-pg.layer.ts";
import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyGenTypesMetadataError } from "./types.errors.ts";
import { type LegacyGenTypesGenerateInput, LegacyGenTypesGenerator } from "./types.generator.ts";

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Timeout parity with the retired pg-meta container path, which received
 * `PG_QUERY_TIMEOUT_SECS` / `PG_CONN_TIMEOUT_SECS` (both set from
 * `--query-timeout`): the query timeout becomes the session's
 * `statement_timeout` (in milliseconds, `0` disables it — same as pg-meta's
 * driver-level `query_timeout`), and the connect timeout applies only when the
 * connection doesn't already carry one (a `--db-url` `connect_timeout` wins).
 */
function applyTimeouts(conn: LegacyPgConnInput, queryTimeoutSeconds: number): LegacyPgConnInput {
  return {
    ...conn,
    connectTimeoutSeconds: conn.connectTimeoutSeconds ?? queryTimeoutSeconds,
    runtimeParams: {
      statement_timeout: `${queryTimeoutSeconds * 1000}`,
      ...conn.runtimeParams,
    },
  };
}

const generate = (input: LegacyGenTypesGenerateInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* legacyAcquirePgPool(
        applyTimeouts(input.conn, input.queryTimeoutSeconds),
        { isLocal: input.isLocal, dnsResolver: input.dnsResolver },
      );

      // `introspect` drives the injected queryable itself, so the foreign
      // Promise boundary is wrapped exactly once here; a live `pg.Pool`
      // satisfies its `Queryable` contract directly.
      const metadata = yield* Effect.tryPromise({
        try: () =>
          introspect(
            pool,
            input.includedSchemas.length > 0 ? { includedSchemas: [...input.includedSchemas] } : {},
          ),
        catch: (cause) =>
          new LegacyGenTypesMetadataError({
            message: `failed to introspect database: ${describeCause(cause)}`,
          }),
      });

      // Canonical sort before generation so output is deterministic regardless
      // of the introspection queries' heap order.
      const sorted = sortGeneratorMetadata(metadata);

      const metadataError = (cause: unknown) =>
        new LegacyGenTypesMetadataError({
          message: `failed to generate ${input.lang} types: ${describeCause(cause)}`,
        });

      switch (input.lang) {
        case "typescript":
          return yield* Effect.tryPromise({
            try: () =>
              generateTypescript(sorted, {
                detectOneToOneRelationships: !input.postgrestV9Compat,
              }),
            catch: metadataError,
          });
        case "go":
          return yield* Effect.try({ try: () => generateGo(sorted), catch: metadataError });
        case "python":
          return yield* Effect.try({ try: () => generatePython(sorted), catch: metadataError });
        case "swift":
          return yield* Effect.try({
            try: () => generateSwift(sorted, { accessControl: input.swiftAccessControl }),
            catch: metadataError,
          });
      }
    }),
  );

/**
 * Production `LegacyGenTypesGenerator`: a scoped `pg.Pool` with the shared
 * driver-layer connection parity (TLS mode, DoH resolver, fallback hosts),
 * introspected and rendered by `@supabase/postgrest-typegen`.
 */
export const legacyGenTypesGeneratorLayer = Layer.succeed(LegacyGenTypesGenerator, { generate });
