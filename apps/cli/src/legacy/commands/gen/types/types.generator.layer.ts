import {
  generateGo,
  generatePython,
  generateSwift,
  generateTypescript,
  sortGeneratorMetadata,
} from "@supabase/postgrest-typegen/generation";
import { introspect } from "@supabase/postgrest-typegen/introspection";
import { Duration, Effect, FileSystem, Layer, Path, Result } from "effect";

import { legacyAcquirePgPool } from "../../../shared/legacy-db-connection.sql-pg.layer.ts";
import { LEGACY_PG_DELTA_CA_BUNDLE } from "../../../shared/legacy-pgdelta-ssl.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { LegacyGenTypesGenerateError, LegacyGenTypesMetadataError } from "./types.errors.ts";
import { type LegacyGenTypesGenerateInput, LegacyGenTypesGenerator } from "./types.generator.ts";
import { legacyOxfmtTypegenFormat } from "./types.oxfmt.ts";
import { applyProbedSslMode, applyQueryTimeouts } from "./types.shared.ts";

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const pinProbedCaBundle = (fs: FileSystem.FileSystem, path: Path.Path) =>
  Effect.gen(function* () {
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-gen-types-ca-" });
    const caPath = path.join(dir, "root.crt");
    yield* fs.writeFileString(caPath, LEGACY_PG_DELTA_CA_BUNDLE);
    return caPath;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyGenTypesGenerateError({
          message: `failed to write TLS CA bundle: ${describeCause(cause)}`,
        }),
    ),
  );

const generate = (
  sslProbe: LegacyPgDeltaSslProbe["Service"],
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: LegacyGenTypesGenerateInput,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      let conn = applyQueryTimeouts(input.conn, input.queryTimeoutSeconds);
      // The driver requires TLS for remote targets, but the retired pg-meta
      // path adapted to the server: its SSLRequest probe decided whether the
      // container connected with TLS at all, so a plain-TCP server (common
      // for self-hosted databases) still worked. Keep that adaptivity: when
      // the DSN carries no explicit `sslmode`, probe the server and disable
      // TLS only when it does not speak SSL. A TLS server gets the same CA
      // pin pg-meta received via `PG_META_DB_SSL_ROOT_CERT`. A probe failure
      // keeps the driver's TLS default so the real connect error (and its
      // IPv6 pooler classification) surfaces from the connection attempt.
      if (!input.isLocal && conn.sslmode === undefined) {
        // A probe error keeps the driver's TLS default so the real connect
        // error (and its IPv6 pooler classification) surfaces from the
        // connection attempt itself.
        const probed = yield* sslProbe.requireSslForHost(conn.host, conn.port).pipe(Effect.result);
        if (Result.isSuccess(probed)) {
          if (!probed.success) {
            conn = applyProbedSslMode(conn, false);
          } else {
            const sslrootcert = yield* pinProbedCaBundle(fs, path);
            conn = applyProbedSslMode(conn, true, sslrootcert);
          }
        }
      }

      const pool = yield* legacyAcquirePgPool(conn, {
        isLocal: input.isLocal,
        dnsResolver: input.dnsResolver,
      });

      // `introspect` drives the injected queryable itself, so the foreign
      // Promise boundary is wrapped exactly once here; a live `pg.Pool`
      // satisfies its `Queryable` contract directly. `statement_timeout`
      // only bounds server-side execution — also cap the client wait so a
      // stalled network cannot hang past `--query-timeout`.
      const introspectEffect = Effect.tryPromise({
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
      const metadata =
        input.queryTimeoutSeconds > 0
          ? yield* introspectEffect.pipe(
              Effect.timeoutOrElse({
                duration: Duration.seconds(input.queryTimeoutSeconds),
                orElse: () =>
                  Effect.fail(
                    new LegacyGenTypesMetadataError({
                      message: `introspection exceeded --query-timeout ${input.queryTimeoutSeconds}s`,
                    }),
                  ),
              }),
            )
          : yield* introspectEffect;

      // Canonical sort before generation so output is deterministic regardless
      // of the introspection queries' heap order.
      const sorted = sortGeneratorMetadata(metadata);

      const generateError = (cause: unknown) =>
        new LegacyGenTypesGenerateError({
          message: `failed to generate ${input.lang} types: ${describeCause(cause)}`,
        });

      switch (input.lang) {
        case "typescript":
          return yield* Effect.tryPromise({
            try: () =>
              generateTypescript(sorted, {
                detectOneToOneRelationships: !input.postgrestV9Compat,
                // The statically-embedded oxfmt binding (see types.oxfmt.ts);
                // the package's own default formatter cannot load its native
                // addon inside the compiled binary.
                format: legacyOxfmtTypegenFormat,
              }),
            catch: generateError,
          });
        case "go":
          return yield* Effect.try({ try: () => generateGo(sorted), catch: generateError });
        case "python":
          return yield* Effect.try({ try: () => generatePython(sorted), catch: generateError });
        case "swift":
          return yield* Effect.try({
            try: () => generateSwift(sorted, { accessControl: input.swiftAccessControl }),
            catch: generateError,
          });
      }
    }),
  );

/**
 * Production `LegacyGenTypesGenerator`: a scoped `pg.Pool` with the shared
 * driver-layer connection parity (TLS mode, DoH resolver, fallback hosts),
 * introspected and rendered by `@supabase/postgrest-typegen`.
 */
export const legacyGenTypesGeneratorLayer = Layer.effect(
  LegacyGenTypesGenerator,
  Effect.gen(function* () {
    const sslProbe = yield* LegacyPgDeltaSslProbe;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return {
      generate: (input: LegacyGenTypesGenerateInput) => generate(sslProbe, fs, path, input),
    };
  }),
);
