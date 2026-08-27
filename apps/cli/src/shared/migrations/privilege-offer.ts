import { Effect } from "effect";
import { analyzeAndSort } from "@supabase/pg-topo";
import {
  SchemaEmptyMigrationStatementsError,
  SchemaPrivilegeOfferError,
} from "../schema/schema-errors.ts";
import { formatPlanSql } from "../schema/schema-body.ts";
import type { SchemaScriptFile } from "../schema/schema-body.ts";
import {
  formatMigrationsPushCommand,
  type MigrationRepairFlags,
} from "./migration-repair-suggest.ts";

/**
 * Turn-off default privileges plus leftover hosted object grants.
 * Must execute on the remote — do not repair --applied.
 */
export const REVOKE_API_PRIVILEGES_SQL = `
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke execute on all functions in schema public from anon, authenticated, service_role;
`;

export const PRIVILEGE_REFRESH_SUGGESTION =
  "Run `supabase db reset` then `supabase schema pull --force` so declarations match. Do not write GRANT ALL or repair.";

export const REVOKE_API_PRIVILEGES_NAME = "revoke_api_privileges";
export const REVOKE_API_PRIVILEGES_TEMPLATE = "revoke-api-privileges";

export function revokeApiPrivilegesTemplateSql(): string {
  return `${REVOKE_API_PRIVILEGES_SQL.trim()}\n`;
}

const API_ROLES = new Set(["anon", "authenticated", "service_role"]);
const IDENT = String.raw`(?:"([^"]+)"|([A-Za-z_][\w$]*))`;
const ACL_STATEMENT = new RegExp(
  String.raw`^ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+${IDENT}\s+IN\s+SCHEMA\s+${IDENT}\s+(?:GRANT|REVOKE)\s+.+\s+(?:TO|FROM)\s+(.+)$`,
  "iu",
);
const GRANT_WORD = /\bGRANT\b/iu;

export type PrivilegeSqlKind = "grant_present" | "revoke_only" | "not_acl";

function identValue(quoted: string | undefined, bare: string | undefined): string {
  return (quoted ?? bare ?? "").toLowerCase();
}

function targetRoles(list: string): ReadonlyArray<string> {
  return list
    .split(",")
    .map((role) => role.trim().replaceAll('"', "").toLowerCase())
    .filter((role) => role.length > 0);
}

function normalizeAclStatement(sql: string): string {
  // pg-topo attaches a leading `--` header to the first statement's sql.
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/--[^\n]*/gu, "");
  const start = stripped.search(/(?:ALTER\s+DEFAULT\s+PRIVILEGES|GRANT\b|REVOKE\b)/iu);
  const body = start === -1 ? stripped : stripped.slice(start);
  return body.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

export function isPublicDefaultAclStatement(statement: string): boolean {
  const match = ACL_STATEMENT.exec(normalizeAclStatement(statement));
  if (match === null) return false;
  if (identValue(match[1], match[2]) !== "postgres") return false;
  if (identValue(match[3], match[4]) !== "public") return false;
  const roles = targetRoles(match[5] ?? "");
  return roles.length > 0 && roles.every((role) => API_ROLES.has(role));
}

export function isPublicObjectAclStatement(statement: string): boolean {
  const body = normalizeAclStatement(statement);
  const match =
    /^(?:GRANT|REVOKE)\s+.+\s+ON\s+(?:ALL\s+)?(FUNCTIONS?|TABLES?|SEQUENCES?)\b(.+)$/iu.exec(body);
  if (match === null) return false;
  const rest = match[2] ?? "";
  const inPublic =
    /\bIN\s+SCHEMA\s+(?:"public"|public)\b/iu.test(rest) || /(?:"public"|public)\./u.test(rest);
  if (!inPublic) return false;
  const rolesMatch = /\s+(?:TO|FROM)\s+(.+)$/iu.exec(rest);
  if (rolesMatch === null) return false;
  const roles = targetRoles(rolesMatch[1] ?? "");
  return roles.length > 0 && roles.every((role) => API_ROLES.has(role));
}

function isPrivilegeStatement(statementClass: string, sql: string): boolean {
  return (
    (statementClass === "ALTER_DEFAULT_PRIVILEGES" && isPublicDefaultAclStatement(sql)) ||
    isPublicObjectAclStatement(sql)
  );
}

function classifyPrivilegeStatements(
  statements: ReadonlyArray<{ readonly statementClass: string; readonly sql: string }>,
): PrivilegeSqlKind {
  if (statements.length === 0) return "not_acl";
  if (!statements.every((node) => isPrivilegeStatement(node.statementClass, node.sql))) {
    return "not_acl";
  }
  return statements.some((node) => GRANT_WORD.test(normalizeAclStatement(node.sql)))
    ? "grant_present"
    : "revoke_only";
}

function isCommentOnly(sql: string): boolean {
  return (
    sql
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/--[^\n]*/gu, "")
      .trim().length === 0
  );
}

export function migrationHasExecutableSql(content: string): boolean {
  return !isCommentOnly(content);
}

export function emptyPendingMigrationError(
  pending: ReadonlyArray<{ readonly fileName: string; readonly content: string }>,
): SchemaEmptyMigrationStatementsError | undefined {
  const empty = pending.find((file) => !migrationHasExecutableSql(file.content));
  if (empty === undefined) return undefined;
  return new SchemaEmptyMigrationStatementsError({
    detail: `${empty.fileName} has no executable SQL.`,
    suggestion: "Put SQL in the file or delete it. Empty migrations cannot be applied or pushed.",
  });
}

function sqlStatements(
  sql: string,
): ReadonlyArray<{ readonly statementClass: string; readonly sql: string }> {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !isCommentOnly(statement))
    .map((statement) => ({ statementClass: "", sql: statement }));
}

export const classifyPrivilegeSql = (sql: string): Effect.Effect<PrivilegeSqlKind> =>
  Effect.tryPromise({
    try: () => analyzeAndSort([sql]),
    catch: () => new Error("privilege-sql-parse"),
  }).pipe(
    Effect.map((result): PrivilegeSqlKind => {
      if (result.diagnostics.some((diagnostic) => diagnostic.code === "PARSE_ERROR")) {
        return classifyPrivilegeStatements(sqlStatements(sql));
      }
      return classifyPrivilegeStatements(result.ordered.filter((node) => !isCommentOnly(node.sql)));
    }),
    Effect.orElseSucceed((): PrivilegeSqlKind => "not_acl"),
  );

export const classifyPrivilegePlan = (plan: {
  readonly files: ReadonlyArray<{ readonly sql: string }>;
}): Effect.Effect<PrivilegeSqlKind> => classifyPrivilegeSql(formatPlanSql(plan));

export const pendingHasPrivilegeSql = (
  pending: ReadonlyArray<{ readonly content: string }>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (const file of pending) {
      const kind = yield* classifyPrivilegeSql(file.content);
      if (kind !== "not_acl") return true;
    }
    return false;
  });

export function privilegeOfferError(
  sql: string,
  flags?: MigrationRepairFlags,
  files?: ReadonlyArray<SchemaScriptFile>,
): SchemaPrivilegeOfferError {
  const push = formatMigrationsPushCommand(flags);
  return new SchemaPrivilegeOfferError({
    detail:
      "Remote default privileges differ from migration replay. Recommended off for least privilege.",
    suggestion: [
      `Turn off: supabase migrations new ${REVOKE_API_PRIVILEGES_NAME} --template ${REVOKE_API_PRIVILEGES_TEMPLATE}, then ${push} (must execute).`,
      `Keep on: api.auto_expose_new_tables is deprecated and will be removed on 2026-10-30. If you still want it, set api.auto_expose_new_tables = true in supabase/config.toml, then supabase db reset && supabase schema pull --force so declarations match the grant-kept baseline, then re-run ${push}. Do not write GRANT ALL or repair.`,
    ].join("\n"),
    sql,
    ...(files !== undefined ? { files } : {}),
  });
}
