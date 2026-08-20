import { Effect } from "effect";
import { SchemaEngineError } from "./schema-errors.ts";

export type DeclarativeShadowClient = {
  readonly query: (sql: string) => Promise<{ readonly rows: ReadonlyArray<unknown> }>;
};

const PG14_PREP = [
  "ALTER TABLE storage.objects ALTER COLUMN id DROP DEFAULT",
  "DROP EXTENSION IF EXISTS pgjwt",
  "DROP EXTENSION IF EXISTS pgcrypto",
  'DROP EXTENSION IF EXISTS "uuid-ossp"',
] as const;

const CURRENT_PREP = [
  "DROP EXTENSION IF EXISTS pgcrypto",
  'DROP EXTENSION IF EXISTS "uuid-ossp"',
] as const;

export const parsePostgresMajorVersion = (serverVersion: string): number => {
  const major = Number.parseInt(serverVersion, 10);
  return Number.isInteger(major) ? major : 0;
};

export const declarativeBaselinePrepStatements = (majorVersion: number): ReadonlyArray<string> =>
  majorVersion === 14 ? PG14_PREP : CURRENT_PREP;

const queryError = (sql: string, cause: unknown) =>
  new SchemaEngineError({
    detail: `Failed to prepare the isolated declaration shadow (${sql}): ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    suggestion:
      "Retry the command. If it persists, delete the Docker shadow baseline cache under ~/.supabase/cache/shadow-baseline.",
  });

const readServerVersion = (rows: ReadonlyArray<unknown>): string => {
  const row = rows[0];
  if (row === undefined || typeof row !== "object" || row === null) return "";
  const value = Reflect.get(row, "server_version");
  return typeof value === "string" ? value : "";
};

export const prepareDeclarativeShadow = (client: DeclarativeShadowClient) =>
  Effect.gen(function* () {
    const versionRows = yield* Effect.tryPromise({
      try: () => client.query("SHOW server_version"),
      catch: (cause) => queryError("SHOW server_version", cause),
    });
    const statements = declarativeBaselinePrepStatements(
      parsePostgresMajorVersion(readServerVersion(versionRows.rows)),
    );
    for (const sql of statements) {
      yield* Effect.tryPromise({
        try: () => client.query(sql),
        catch: (cause) => queryError(sql, cause),
      });
    }
  });
