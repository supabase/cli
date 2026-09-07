import { Effect } from "effect";

import { LegacyPgDeltaEngineError } from "./legacy-pgdelta-engine.service.ts";

export type LegacyDeclarativeShadowClient = {
  readonly query: (sql: string) => Promise<{ readonly rows: ReadonlyArray<unknown> }>;
};

interface LegacyDeclarativeShadowPrepResult {
  /** True only when prep dropped an installed image pgjwt to recreate pgcrypto. */
  readonly restorePgjwt: boolean;
}

/** Image-default extensions the user may still declare; omit means keep the install. */
const IMAGE_DEFAULT_EXTENSIONS = ["pgjwt", "pgcrypto", "uuid-ossp"] as const;

const IMAGE_DEFAULT_EXTENSION_SET = new Set<string>(IMAGE_DEFAULT_EXTENSIONS);

const DROP_IMAGE_DEFAULT_EXTENSION: Record<(typeof IMAGE_DEFAULT_EXTENSIONS)[number], string> = {
  pgjwt: "DROP EXTENSION IF EXISTS pgjwt",
  pgcrypto: "DROP EXTENSION IF EXISTS pgcrypto",
  "uuid-ossp": 'DROP EXTENSION IF EXISTS "uuid-ossp"',
};

const CREATE_EXTENSION_RE =
  /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][\w$-]*))/gi;

/** Blank comments and simple strings; keep offsets for locateSignature line mapping. */
export const legacyMaskSqlComments = (sql: string): string =>
  sql.replaceAll(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (matched) =>
    matched.replaceAll(/[^\r\n]/g, " "),
  );

export const legacyDeclaredSqlExtensions = (
  files: ReadonlyArray<{ readonly name: string; readonly sql: string }>,
): ReadonlySet<string> => {
  const declared = new Set<string>();
  for (const file of files) {
    for (const match of legacyMaskSqlComments(file.sql).matchAll(CREATE_EXTENSION_RE)) {
      const name = (match[1] ?? match[2] ?? "").toLowerCase();
      if (name !== "") declared.add(name);
    }
  }
  return declared;
};

const declaredImageExtensions = (
  files: ReadonlyArray<{ readonly name: string; readonly sql: string }>,
): ReadonlySet<string> => {
  const declared = new Set<string>();
  for (const name of legacyDeclaredSqlExtensions(files)) {
    if (IMAGE_DEFAULT_EXTENSION_SET.has(name)) declared.add(name);
  }
  return declared;
};

const legacyParsePostgresMajorVersion = (serverVersion: string): number => {
  const major = Number.parseInt(serverVersion, 10);
  return Number.isInteger(major) ? major : 0;
};

const legacyDeclarativeBaselinePrepStatements = (
  majorVersion: number,
  declared: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const dropPgcrypto = declared.has("pgcrypto");
  // Image pgjwt depends on pgcrypto; drop it first so pgcrypto can drop.
  const dropPgjwt = declared.has("pgjwt") || dropPgcrypto;
  const dropUuidOssp = declared.has("uuid-ossp");
  const statements: string[] = [];
  if (majorVersion === 14 && dropUuidOssp) {
    statements.push("ALTER TABLE storage.objects ALTER COLUMN id DROP DEFAULT");
  }
  if (dropPgjwt) statements.push(DROP_IMAGE_DEFAULT_EXTENSION.pgjwt);
  if (dropPgcrypto) statements.push(DROP_IMAGE_DEFAULT_EXTENSION.pgcrypto);
  if (dropUuidOssp) statements.push(DROP_IMAGE_DEFAULT_EXTENSION["uuid-ossp"]);
  return statements;
};

/** Recreate image pgjwt after a pgcrypto-only drop so omit still means keep. */
export const legacyFilesForDeclarativeShadowLoad = (
  files: ReadonlyArray<{ readonly name: string; readonly sql: string }>,
  restorePgjwt: boolean,
): ReadonlyArray<{ readonly name: string; readonly sql: string }> => {
  if (!restorePgjwt) return files;
  return [
    ...files,
    {
      name: "_cli/restore-pgjwt.sql",
      sql: "CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;\n",
    },
  ];
};

/** User cannot edit this SQL; a persistent miss is a CLI bug. */
const DECLARATIVE_SHADOW_PREP_FAILURE_SUGGESTION =
  "This statement is CLI-owned shadow prep, not a project migration or schema file. If it persists, report it with supabase issue bug.";

const queryError = (sql: string, cause: unknown) =>
  new LegacyPgDeltaEngineError({
    message: `Failed to prepare the isolated declaration shadow (${sql}): ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    cause,
    suggestion: DECLARATIVE_SHADOW_PREP_FAILURE_SUGGESTION,
  });

const readServerVersion = (rows: ReadonlyArray<unknown>): string => {
  const row = rows[0];
  if (row === undefined || typeof row !== "object" || row === null) return "";
  const value = Reflect.get(row, "server_version");
  return typeof value === "string" ? value : "";
};

const rowHasPgjwt = (rows: ReadonlyArray<unknown>): boolean =>
  rows.some((row) => {
    if (typeof row !== "object" || row === null) return false;
    const name = Reflect.get(row, "extname");
    return name === "pgjwt";
  });

const INSTALLED_PGJWT_SQL = "SELECT extname FROM pg_extension WHERE extname = 'pgjwt'";

const queryShadow = (client: LegacyDeclarativeShadowClient, sql: string) =>
  Effect.tryPromise({
    try: () => client.query(sql),
    catch: (cause) => queryError(sql, cause),
  });

export const legacyPrepareDeclarativeShadow = (
  client: LegacyDeclarativeShadowClient,
  files: ReadonlyArray<{ readonly name: string; readonly sql: string }>,
) =>
  Effect.gen(function* () {
    const declared = declaredImageExtensions(files);
    if (declared.size === 0)
      return { restorePgjwt: false } satisfies LegacyDeclarativeShadowPrepResult;
    let restorePgjwt = false;
    if (declared.has("pgcrypto") && !declared.has("pgjwt")) {
      const installed = yield* queryShadow(client, INSTALLED_PGJWT_SQL);
      restorePgjwt = rowHasPgjwt(installed.rows);
    }
    const versionRows = yield* queryShadow(client, "SHOW server_version");
    const statements = legacyDeclarativeBaselinePrepStatements(
      legacyParsePostgresMajorVersion(readServerVersion(versionRows.rows)),
      declared,
    );
    for (const sql of statements) {
      yield* queryShadow(client, sql);
    }
    return { restorePgjwt } satisfies LegacyDeclarativeShadowPrepResult;
  });
