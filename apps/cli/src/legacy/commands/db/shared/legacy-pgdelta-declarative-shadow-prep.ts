import { Effect } from "effect";

import { LegacyPgDeltaEngineError } from "./legacy-pgdelta-engine.service.ts";

export type LegacyDeclarativeShadowConnection = {
  readonly query: (sql: string) => Promise<{ readonly rows: ReadonlyArray<unknown> }>;
  readonly release: (error?: Error | boolean) => void;
  readonly on?: (event: "error", listener: (error: Error) => void) => void;
  readonly removeListener?: (event: "error", listener: (error: Error) => void) => void;
};

export type LegacyDeclarativeShadowClient = {
  readonly connect: () => Promise<LegacyDeclarativeShadowConnection>;
};

export interface LegacyDeclarativeShadowPrepResult {
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

const DOLLAR_TAG_RE = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/;

const isIdentChar = (ch: string): boolean =>
  (ch >= "A" && ch <= "Z") ||
  (ch >= "a" && ch <= "z") ||
  (ch >= "0" && ch <= "9") ||
  ch === "_" ||
  ch === "$";

const isIdentStart = (ch: string): boolean =>
  (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";

const isWs = (ch: string | undefined): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

/** `E'...'` / `e'...'` only when E is not part of a preceding identifier. */
const isEscapeString = (sql: string, quoteIndex: number): boolean => {
  if (quoteIndex < 1) return false;
  const prefix = sql[quoteIndex - 1];
  if (prefix !== "E" && prefix !== "e") return false;
  if (quoteIndex === 1) return true;
  return !isIdentChar(sql[quoteIndex - 2] ?? "");
};

const blankRange = (sql: string, start: number, end: number): string => {
  let blanked = "";
  for (let i = start; i < end; i++) {
    const ch = sql[i];
    blanked += ch === "\n" || ch === "\r" ? ch : " ";
  }
  return blanked;
};

/** Blank comments and literals, including nested block comments and E-string escapes. */
const maskSqlNonCode = (sql: string): string => {
  const out: string[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i] ?? "";
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const start = i;
      while (i < n && sql[i] !== "\n") i++;
      out.push(blankRange(sql, start, i));
      continue;
    }
    if (c === "/" && next === "*") {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      out.push(blankRange(sql, start, i));
      continue;
    }
    if (c === "'") {
      const start = i;
      const escape = isEscapeString(sql, i);
      i += 1;
      while (i < n) {
        if (escape && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      out.push(blankRange(sql, start, i));
      continue;
    }
    if (c === "$") {
      const tagMatch = DOLLAR_TAG_RE.exec(sql.slice(i));
      if (tagMatch !== null) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        out.push(blankRange(sql, i, stop));
        i = stop;
        continue;
      }
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
};

const matchKeyword = (sql: string, i: number, word: string): number | undefined => {
  if (i > 0 && isIdentChar(sql[i - 1] ?? "")) return undefined;
  const end = i + word.length;
  if (sql.slice(i, end).toLowerCase() !== word) return undefined;
  const next = sql[end];
  if (next !== undefined && isIdentChar(next)) return undefined;
  return end;
};

const skipWs = (sql: string, i: number): number => {
  while (isWs(sql[i])) i += 1;
  return i;
};

const readQuotedIdent = (sql: string, start: number): { value: string; end: number } => {
  let i = start + 1;
  let value = "";
  while (i < sql.length) {
    if (sql[i] === '"' && sql[i + 1] === '"') {
      value += '"';
      i += 2;
    } else if (sql[i] === '"') {
      return { value, end: i + 1 };
    } else {
      value += sql[i] ?? "";
      i += 1;
    }
  }
  return { value, end: i };
};

/** CREATE EXTENSION names only; skip `"CREATE EXTENSION pgcrypto"` identifiers. */
const scanCreateExtensionNames = (sql: string): ReadonlyArray<string> => {
  const names: string[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === '"') {
      i = readQuotedIdent(sql, i).end;
      continue;
    }
    const afterCreate = matchKeyword(sql, i, "create");
    if (afterCreate === undefined) {
      i += 1;
      continue;
    }
    let j = skipWs(sql, afterCreate);
    const afterExt = matchKeyword(sql, j, "extension");
    if (afterExt === undefined) {
      i += 1;
      continue;
    }
    j = skipWs(sql, afterExt);
    const afterIf = matchKeyword(sql, j, "if");
    if (afterIf !== undefined) {
      const afterNot = matchKeyword(sql, skipWs(sql, afterIf), "not");
      if (afterNot !== undefined) {
        const afterExists = matchKeyword(sql, skipWs(sql, afterNot), "exists");
        if (afterExists !== undefined) j = skipWs(sql, afterExists);
      }
    }
    if (sql[j] === '"') {
      const ident = readQuotedIdent(sql, j);
      if (ident.value !== "") names.push(ident.value.toLowerCase());
      i = ident.end;
      continue;
    }
    if (sql[j] !== undefined && isIdentStart(sql[j] ?? "")) {
      const start = j;
      j += 1;
      while (j < n && (isIdentChar(sql[j] ?? "") || sql[j] === "-")) j += 1;
      names.push(sql.slice(start, j).toLowerCase());
      i = j;
      continue;
    }
    i = afterExt;
  }
  return names;
};

export const legacyDeclaredSqlExtensions = (
  files: ReadonlyArray<{ readonly name: string; readonly sql: string }>,
): ReadonlySet<string> => {
  const declared = new Set<string>();
  for (const file of files) {
    for (const name of scanCreateExtensionNames(maskSqlNonCode(file.sql))) {
      declared.add(name);
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

export const legacyParsePostgresMajorVersion = (serverVersion: string): number => {
  const major = Number.parseInt(serverVersion, 10);
  return Number.isInteger(major) ? major : 0;
};

export const legacyDeclarativeBaselinePrepStatements = (
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
const SHADOW_PREP_INTERRUPTED = "shadow prep interrupted";

/** Checkout so interrupt can discard a locked DROP instead of hanging the shared pool. */
const queryShadow = (client: LegacyDeclarativeShadowClient, sql: string) =>
  Effect.callback<{ readonly rows: ReadonlyArray<unknown> }, LegacyPgDeltaEngineError>((resume) => {
    let settled = false;
    let released = false;
    let conn: LegacyDeclarativeShadowConnection | undefined;
    const onError = (error: Error) => {
      finish(Effect.fail(queryError(sql, error)), error);
    };
    const releaseConn = (error?: Error) => {
      if (released || conn === undefined) return;
      released = true;
      conn.removeListener?.("error", onError);
      conn.release(error);
    };
    const finish = (
      effect: Effect.Effect<{ readonly rows: ReadonlyArray<unknown> }, LegacyPgDeltaEngineError>,
      releaseError?: Error,
    ) => {
      if (settled) return;
      settled = true;
      releaseConn(releaseError);
      resume(effect);
    };
    void client.connect().then(
      (acquired) => {
        conn = acquired;
        acquired.on?.("error", onError);
        if (settled) {
          releaseConn(new Error(SHADOW_PREP_INTERRUPTED));
          return;
        }
        void acquired.query(sql).then(
          (result) => finish(Effect.succeed(result)),
          (cause) =>
            finish(
              Effect.fail(queryError(sql, cause)),
              cause instanceof Error ? cause : new Error(String(cause)),
            ),
        );
      },
      (cause) => finish(Effect.fail(queryError(sql, cause))),
    );
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      releaseConn(new Error(SHADOW_PREP_INTERRUPTED));
    });
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
