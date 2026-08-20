import { formatSqlStatements, type SqlFormatOptions } from "@supabase/pg-delta/sql-format";

/** Human-readable SQL for pg-delta emitters when no override is supplied. */
export const SCHEMA_SQL_FORMAT_DEFAULTS = {
  keywordCase: "upper",
  indent: 2,
  maxWidth: 180,
  commaStyle: "trailing",
  alignColumns: true,
  alignKeyValues: true,
} satisfies SqlFormatOptions;

function terminateStatement(sql: string): string {
  const trimmed = sql.trimEnd();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

export function formatSchemaSql(sql: string, options: SqlFormatOptions | undefined): string {
  if (options === undefined) return sql;
  return `${formatSqlStatements([sql], options).map(terminateStatement).join("\n\n")}\n`;
}
