import {
  MIGRATE_FILE_PATTERN,
  MIGRATION_NO_TRANSACTION_DIRECTIVE,
} from "../schema/schema-paths.ts";

export type MigrationFile = {
  readonly version: string;
  readonly name: string;
  readonly fileName: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly transactional: boolean;
};

export function formatMigrationTimestamp(millis: number): string {
  return new Date(millis).toISOString().replace(/\D/gu, "").slice(0, 14);
}

export function parseMigrationFileName(
  fileName: string,
): { version: string; name: string } | undefined {
  const match = MIGRATE_FILE_PATTERN.exec(fileName);
  if (match === null) return undefined;
  const version = match[1];
  const name = match[2];
  if (version === undefined || name === undefined) return undefined;
  return { version, name };
}

export function migrationFileName(version: string, name: string, suffix?: string | null): string {
  return suffix === undefined || suffix === null || suffix === ""
    ? `${version}_${name}.sql`
    : `${version}_${name}_${suffix}.sql`;
}

export function parseMigrationContent(content: string): {
  readonly transactional: boolean;
} {
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const firstNewline = withoutBom.indexOf("\n");
  const rawFirstLine = firstNewline < 0 ? withoutBom : withoutBom.slice(0, firstNewline);
  const firstLine = rawFirstLine.endsWith("\r") ? rawFirstLine.slice(0, -1) : rawFirstLine;
  return { transactional: firstLine !== MIGRATION_NO_TRANSACTION_DIRECTIVE };
}
