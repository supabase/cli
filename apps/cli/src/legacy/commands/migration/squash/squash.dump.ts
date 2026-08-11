import { Effect } from "effect";

import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import {
  legacyBuildSchemaDumpEnv,
  type LegacyDumpOptions,
} from "../../../shared/legacy-pg-dump.env.ts";
import { legacyDumpSchemaScript } from "../../../shared/legacy-pg-dump.scripts.ts";
import { legacyStreamPgDump } from "../../../shared/legacy-pg-dump.run.ts";
import { LegacyMigrationSquashDumpError } from "./squash.errors.ts";

/**
 * Input to {@link legacySquashDumpSchema} — squash's own thin wrapper over one
 * `migration.DumpSchema` call (`pkg/migration/dump.go`).
 */
export interface LegacySquashDumpParams<E> {
  /**
   * `utils.Config.Db.Image` — the pin-resolved (not yet registry-mapped) Postgres
   * image (`localInputs.bootstrapConfig.postgresImage`); {@link legacyStreamPgDump}
   * applies the registry mirror itself, mirroring Go's `DockerStart` ->
   * `GetRegistryImageUrl`.
   */
  readonly image: string;
  /** The shadow's own connect target (host / shadow port / `postgres` / password / `postgres`). */
  readonly conn: LegacyPgConnInput;
  /** `["auth","storage"]` for the before/after diff dumps, `[]` for the unrestricted full dump. */
  readonly schema: ReadonlyArray<string>;
  /** Receives each stdout chunk in arrival order; its failure aborts the run as `E`. */
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
  /** Loaded project `supabase/.env` map — forwarded to {@link legacyStreamPgDump}'s own `SUPABASE_NETWORK_ID` fallback. */
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}

/**
 * Port of Go's `migration.DumpSchema(ctx, cfg, w, dump.DockerExec, opts...)`
 * (`pkg/migration/dump.go`): a schema-only `pg_dump`, streamed to `onStdout` at
 * constant memory. `squashMigrations` calls this exactly three times
 * (`apps/cli-go/internal/migration/squash/squash.go:109,116,126`): before/after
 * with `WithSchema("auth","storage")`, and a third, unrestricted call for the final
 * full dump written straight to the target migration file.
 */
export const legacySquashDumpSchema = Effect.fnUntraced(function* <E>(
  params: LegacySquashDumpParams<E>,
) {
  const opt: LegacyDumpOptions = {
    schema: params.schema,
    keepComments: false,
    excludeTable: [],
    columnInsert: false,
  };
  const result = yield* legacyStreamPgDump({
    image: params.image,
    script: legacyDumpSchemaScript,
    env: legacyBuildSchemaDumpEnv(params.conn, opt),
    onStdout: params.onStdout,
    projectEnvValues: params.projectEnvValues,
  });
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new LegacyMigrationSquashDumpError({
        message: `error running container: exit ${result.exitCode}`,
      }),
    );
  }
});

/** Concatenates stdout chunks into one buffer, mirroring Go's `bytes.Buffer` sink. */
const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

/**
 * Buffered convenience over {@link legacySquashDumpSchema} for the before/after
 * diff dumps — mirrors Go's own `bytes.Buffer` sink (`squash.go:108`), which is
 * inherently in-memory too: an `auth`/`storage` schema-only dump is tens of KB, not
 * a streaming-scale payload. The FULL dump never goes through this — it streams
 * straight to the target migration file's own handle at constant memory
 * (`squash.handler.ts`'s `squashMigrations`).
 */
export const legacySquashDumpSchemaToString = Effect.fnUntraced(function* (params: {
  readonly image: string;
  readonly conn: LegacyPgConnInput;
  readonly schema: ReadonlyArray<string>;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}) {
  const chunks: Array<Uint8Array> = [];
  yield* legacySquashDumpSchema({
    image: params.image,
    conn: params.conn,
    schema: params.schema,
    onStdout: (chunk) => Effect.sync(() => chunks.push(chunk)),
    projectEnvValues: params.projectEnvValues,
  });
  return new TextDecoder().decode(concatChunks(chunks));
});
