import { Effect } from "effect";

import { splitSql } from "../../../command-internal/sql-split.ts";
import { PgDeltaEngineError } from "./pgdelta-engine.service.ts";

export type DeclarativeShadowClient = {
  readonly query: (sql: string) => Promise<{ readonly rows: ReadonlyArray<unknown> }>;
};

interface DeclarativeShadowPrepResult {
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

/**
 * Image-installed extensions that stay in the shadow: tables already use their access method, so
 * they cannot be dropped for replay and their declarations load as `IF NOT EXISTS`.
 */
const IMAGE_KEPT_EXTENSIONS = new Set(["orioledb"]);

const CREATE_EXTENSION_RE =
  /\b(CREATE\s+EXTENSION\s+)(IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][\w$-]*))/gi;

const createExtensionName = (match: RegExpMatchArray): string =>
  (match[3] ?? match[4] ?? "").toLowerCase();

/** Blank comments and simple strings; keep offsets for locateSignature line mapping. */
export const maskSqlComments = (sql: string): string =>
  sql.replaceAll(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (matched) =>
    matched.replaceAll(/[^\r\n]/g, " "),
  );

export const declaredSqlExtensions = (
  files: ReadonlyArray<{ readonly name: string; readonly sql: string }>,
): ReadonlySet<string> => {
  const declared = new Set<string>();
  for (const file of files) {
    for (const match of maskSqlComments(file.sql).matchAll(CREATE_EXTENSION_RE)) {
      const name = createExtensionName(match);
      if (name !== "") declared.add(name);
    }
  }
  return declared;
};

const declaredImageExtensions = (
  files: ReadonlyArray<{ readonly name: string; readonly sql: string }>,
): ReadonlySet<string> => {
  const declared = new Set<string>();
  for (const name of declaredSqlExtensions(files)) {
    if (IMAGE_DEFAULT_EXTENSION_SET.has(name)) declared.add(name);
  }
  return declared;
};

const parsePostgresMajorVersion = (serverVersion: string): number => {
  const major = Number.parseInt(serverVersion, 10);
  return Number.isInteger(major) ? major : 0;
};

const declarativeBaselinePrepStatements = (
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

const EXTENSION_NAME = /"([^"]+)"|([a-zA-Z_][\w$-]*)/y;

/** Index after the whitespace and comments at `from`; block comments nest as in PostgreSQL. */
const afterTrivia = (sql: string, from: number): number => {
  let at = from;
  for (;;) {
    if (/\s/.test(sql[at] ?? "")) at += 1;
    else if (sql.startsWith("--", at)) {
      while (at < sql.length && sql[at] !== "\n" && sql[at] !== "\r") at += 1;
    } else if (sql.startsWith("/*", at)) {
      let depth = 0;
      let end = at;
      do {
        if (end >= sql.length) return at;
        if (sql.startsWith("/*", end)) depth += 1;
        else if (sql.startsWith("*/", end)) depth -= 1;
        end += sql.startsWith("/*", end) || sql.startsWith("*/", end) ? 2 : 1;
      } while (depth > 0);
      at = end;
    } else return at;
  }
};

/** Index after the trivia that follows `keyword` at `at`, or `undefined` when it is not there. */
const afterKeyword = (sql: string, at: number, keyword: string): number | undefined => {
  const end = at + keyword.length;
  if (sql.slice(at, end).toLowerCase() !== keyword || /[\w$]/.test(sql[end] ?? ""))
    return undefined;
  return afterTrivia(sql, end);
};

/** Rewrites whole statements only, so literals, identifiers, and bodies stay as written. */
const keepImageExtensionCreate = (statement: string): string => {
  const create = afterKeyword(statement, afterTrivia(statement, 0), "create");
  const nameAt = create === undefined ? undefined : afterKeyword(statement, create, "extension");
  if (nameAt === undefined || afterKeyword(statement, nameAt, "if") !== undefined) return statement;
  EXTENSION_NAME.lastIndex = nameAt;
  const name = EXTENSION_NAME.exec(statement);
  if (!IMAGE_KEPT_EXTENSIONS.has((name?.[1] ?? name?.[2] ?? "").toLowerCase())) return statement;
  return `${statement.slice(0, nameAt)}IF NOT EXISTS ${statement.slice(nameAt)}`;
};

const keepImageExtensionCreates = (sql: string): string =>
  [...IMAGE_KEPT_EXTENSIONS].some((name) => sql.toLowerCase().includes(name))
    ? splitSql(sql, keepImageExtensionCreate).join("")
    : sql;

/**
 * Shadow-load view of the declarations: kept image extensions load idempotently, and image pgjwt
 * is recreated after a pgcrypto-only drop so omit still means keep.
 */
export const filesForDeclarativeShadowLoad = (
  files: ReadonlyArray<{ readonly name: string; readonly sql: string }>,
  restorePgjwt: boolean,
): ReadonlyArray<{ readonly name: string; readonly sql: string }> => {
  const loaded = files.map((file) => {
    const sql = keepImageExtensionCreates(file.sql);
    return sql === file.sql ? file : { ...file, sql };
  });
  if (!restorePgjwt) return loaded;
  return [
    ...loaded,
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
  new PgDeltaEngineError({
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

const queryShadow = (client: DeclarativeShadowClient, sql: string) =>
  Effect.tryPromise({
    try: () => client.query(sql),
    catch: (cause) => queryError(sql, cause),
  });

export const prepareDeclarativeShadow = Effect.fn("PgDeltaDeclarativeShadow.prepare")(function* (
  client: DeclarativeShadowClient,
  files: ReadonlyArray<{
    readonly name: string;
    readonly sql: string;
  }>,
) {
  const declared = declaredImageExtensions(files);
  if (declared.size === 0) return { restorePgjwt: false } satisfies DeclarativeShadowPrepResult;
  let restorePgjwt = false;
  if (declared.has("pgcrypto") && !declared.has("pgjwt")) {
    const installed = yield* queryShadow(client, INSTALLED_PGJWT_SQL);
    restorePgjwt = rowHasPgjwt(installed.rows);
  }
  const versionRows = yield* queryShadow(client, "SHOW server_version");
  const statements = declarativeBaselinePrepStatements(
    parsePostgresMajorVersion(readServerVersion(versionRows.rows)),
    declared,
  );
  for (const sql of statements) {
    yield* queryShadow(client, sql);
  }
  return { restorePgjwt } satisfies DeclarativeShadowPrepResult;
});
