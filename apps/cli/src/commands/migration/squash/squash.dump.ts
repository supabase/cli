import { Effect } from "effect";

import type { PgConnInput } from "../../../command-internal/db-connection.service.ts";
import { buildSchemaDumpEnv, type DumpOptions } from "../../../command-internal/pg-dump.env.ts";
import { dumpSchemaScript } from "../../../command-internal/pg-dump.scripts.ts";
import { streamPgDump } from "../../../command-internal/pg-dump.run.ts";
import { MigrationSquashDumpError } from "./squash.errors.ts";

/**
 * Input to {@link squashDumpSchema} — squash's own thin wrapper over one
 * schema-dump call.
 */
export interface SquashDumpParams<E> {
  /**
   * The pin-resolved (not yet registry-mapped) Postgres
   * image (`localInputs.bootstrapConfig.postgresImage`); {@link streamPgDump}
   * applies the registry mirror itself.
   */
  readonly image: string;
  /** The shadow's own connect target (host / shadow port / `postgres` / password / `postgres`). */
  readonly conn: PgConnInput;
  /** `["auth","storage"]` for the before/after diff dumps, `[]` for the unrestricted full dump. */
  readonly schema: ReadonlyArray<string>;
  /** Receives each stdout chunk in arrival order; its failure aborts the run as `E`. */
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
  /** Loaded project `supabase/.env` map — forwarded to {@link streamPgDump}'s own `SUPABASE_NETWORK_ID` fallback. */
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}

/**
 * A schema-only `pg_dump`, streamed to `onStdout` at
 * constant memory. `squashMigrations` calls this exactly three times: before/after
 * with `WithSchema("auth","storage")`, and a third, unrestricted call for the final
 * full dump written straight to the target migration file.
 */
export const squashDumpSchema = Effect.fnUntraced(function* <E>(params: SquashDumpParams<E>) {
  const opt: DumpOptions = {
    schema: params.schema,
    keepComments: false,
    excludeTable: [],
    columnInsert: false,
  };
  const result = yield* streamPgDump({
    image: params.image,
    script: dumpSchemaScript,
    env: buildSchemaDumpEnv(params.conn, opt),
    onStdout: params.onStdout,
    projectEnvValues: params.projectEnvValues,
  });
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new MigrationSquashDumpError({
        message: `error running container: exit ${result.exitCode}`,
      }),
    );
  }
});

/** Concatenates stdout chunks into one buffer. */
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
 * Buffered convenience over {@link squashDumpSchema} for the before/after
 * diff dumps — an `auth`/`storage` schema-only dump is tens of KB, not
 * a streaming-scale payload. The full dump never goes through this — it streams
 * straight to the target migration file's own handle at constant memory
 * (`squash.handler.ts`'s `squashMigrations`).
 */
export const squashDumpSchemaToString = Effect.fnUntraced(function* (params: {
  readonly image: string;
  readonly conn: PgConnInput;
  readonly schema: ReadonlyArray<string>;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}) {
  const chunks: Array<Uint8Array> = [];
  yield* squashDumpSchema({
    image: params.image,
    conn: params.conn,
    schema: params.schema,
    onStdout: (chunk) => Effect.sync(() => chunks.push(chunk)),
    projectEnvValues: params.projectEnvValues,
  });
  return new TextDecoder().decode(concatChunks(chunks));
});
