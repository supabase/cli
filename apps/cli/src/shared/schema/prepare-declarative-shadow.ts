import { Effect } from "effect";
import { SchemaEngineError } from "./schema-errors.ts";
import type { SchemaSqlFile } from "./schema-types.ts";

export type DeclarativeShadowClient = {
  readonly query: (sql: string) => Promise<{ readonly rows: ReadonlyArray<unknown> }>;
};

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

/** Blank comments and literals so CREATE EXTENSION in those positions is ignored. */
const maskSqlNonCode = (sql: string): string =>
  sql.replaceAll(
    /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|\$(?:[a-zA-Z_][\w$]*)?\$[\s\S]*?\$(?:[a-zA-Z_][\w$]*)?\$/g,
    (matched) => matched.replaceAll(/[^\r\n]/g, " "),
  );

export const declaredSqlExtensions = (
  files: ReadonlyArray<{ readonly name: string; readonly sql: string }>,
): ReadonlySet<string> => {
  const declared = new Set<string>();
  for (const file of files) {
    for (const match of maskSqlNonCode(file.sql).matchAll(CREATE_EXTENSION_RE)) {
      const name = (match[1] ?? match[2] ?? "").toLowerCase();
      if (name !== "") declared.add(name);
    }
  }
  return declared;
};

const stripAllowedExtensionCatchup = (sql: string): string =>
  maskSqlNonCode(sql)
    .replace(/\bSET\s+[^;]*;/giu, "")
    .replace(/\bCREATE\s+EXTENSION\s+[^;]*;/giu, "")
    .replace(/\bCOMMENT\s+ON\s+EXTENSION\s+[^;]*;/giu, "")
    .replace(/\s+/gu, " ")
    .trim();

/** First-push catchup that only recreates image-default extensions. */
export function isImageExtensionCatchupSql(sql: string): boolean {
  const declared = declaredSqlExtensions([{ name: "catchup.sql", sql }]);
  if (declared.size === 0) return false;
  if ([...declared].some((name) => !IMAGE_DEFAULT_EXTENSION_SET.has(name))) return false;
  return stripAllowedExtensionCatchup(sql) === "";
}

/** True when that catchup is already installed on the live catalog. */
export function imageExtensionCatchupAlreadyPresent(
  sql: string,
  installed: ReadonlySet<string>,
): boolean {
  if (!isImageExtensionCatchupSql(sql)) return false;
  const declared = declaredSqlExtensions([{ name: "catchup.sql", sql }]);
  return [...declared].every((name) => installed.has(name));
}

const declaredImageExtensions = (files: ReadonlyArray<SchemaSqlFile>): ReadonlySet<string> => {
  const declared = new Set<string>();
  for (const name of declaredSqlExtensions(files)) {
    if (IMAGE_DEFAULT_EXTENSION_SET.has(name)) declared.add(name);
  }
  return declared;
};

export const parsePostgresMajorVersion = (serverVersion: string): number => {
  const major = Number.parseInt(serverVersion, 10);
  return Number.isInteger(major) ? major : 0;
};

export const declarativeBaselinePrepStatements = (
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
export const filesForDeclarativeShadowLoad = (
  files: ReadonlyArray<SchemaSqlFile>,
): ReadonlyArray<SchemaSqlFile> => {
  const declared = declaredImageExtensions(files);
  if (!declared.has("pgcrypto") || declared.has("pgjwt")) return files;
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
  new SchemaEngineError({
    detail: `Failed to prepare the isolated declaration shadow (${sql}): ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    suggestion: DECLARATIVE_SHADOW_PREP_FAILURE_SUGGESTION,
  });

const readServerVersion = (rows: ReadonlyArray<unknown>): string => {
  const row = rows[0];
  if (row === undefined || typeof row !== "object" || row === null) return "";
  const value = Reflect.get(row, "server_version");
  return typeof value === "string" ? value : "";
};

export const prepareDeclarativeShadow = (
  client: DeclarativeShadowClient,
  files: ReadonlyArray<SchemaSqlFile>,
) =>
  Effect.gen(function* () {
    const declared = declaredImageExtensions(files);
    if (declared.size === 0) return;
    const versionRows = yield* Effect.tryPromise({
      try: () => client.query("SHOW server_version"),
      catch: (cause) => queryError("SHOW server_version", cause),
    });
    const statements = declarativeBaselinePrepStatements(
      parsePostgresMajorVersion(readServerVersion(versionRows.rows)),
      declared,
    );
    for (const sql of statements) {
      yield* Effect.tryPromise({
        try: () => client.query(sql),
        catch: (cause) => queryError(sql, cause),
      });
    }
  });
