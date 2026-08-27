import type { DatabaseTarget } from "../database/database-target.ts";
import { envDatabaseUrlVarName } from "../database/database-target.ts";

export type MigrationRepairFlags = {
  readonly local?: boolean;
  readonly dbUrlEnvVar?: "DATABASE_URL" | "SUPABASE_DB_URL";
  readonly dbUrlSame?: boolean;
  readonly projectRef?: string;
};

export function repairFlagsForTarget(
  target: DatabaseTarget,
  opts: { readonly projectRef?: string; readonly dbUrl?: string } = {},
): MigrationRepairFlags {
  if (target.kind === "local") {
    return { local: true };
  }
  if (target.kind === "url" || opts.dbUrl !== undefined) {
    if (target.connectionSource === "env") {
      return { dbUrlEnvVar: envDatabaseUrlVarName() ?? "DATABASE_URL" };
    }
    return { dbUrlSame: true };
  }
  const projectRef = opts.projectRef ?? target.projectRef;
  return projectRef !== undefined ? { projectRef } : {};
}

function formatAgainstSelector(flags?: MigrationRepairFlags): string {
  if (flags?.local === true) return "local";
  if (flags?.dbUrlEnvVar !== undefined) return `"$${flags.dbUrlEnvVar}"`;
  if (flags?.dbUrlSame === true) return "<same-url>";
  return "linked";
}

export function formatMigrationsPushCommand(flags?: MigrationRepairFlags): string {
  if (flags?.local === true) return "supabase migrations apply";
  const parts = ["supabase", "migrations", "push"];
  if (flags?.dbUrlEnvVar !== undefined) {
    parts.push("--db-url", `"$${flags.dbUrlEnvVar}"`, "--allow-remote");
  } else if (flags?.dbUrlSame === true) {
    parts.push("--db-url", "<same-url>", "--allow-remote");
  }
  return parts.join(" ");
}

function formatMigrationsPullFrom(flags?: MigrationRepairFlags): string {
  return `--from ${formatAgainstSelector(flags)}`;
}

export function formatMigrationsPullCommand(flags?: MigrationRepairFlags): string {
  return `supabase migrations pull ${formatMigrationsPullFrom(flags)}`;
}

export function formatSchemaPullCommand(flags?: MigrationRepairFlags): string {
  return `supabase schema pull ${formatMigrationsPullFrom(flags)}`;
}

export function formatMigrationsDiffFileCommand(flags?: MigrationRepairFlags): string {
  return `supabase migrations diff --against ${formatAgainstSelector(flags)} --file supabase/migrations/<version>_<name>.sql`;
}

export function formatLiveEditCommands(flags?: MigrationRepairFlags): string {
  return [
    formatMigrationsDiffFileCommand(flags),
    formatMigrationRepairCommand({
      status: "applied",
      versions: ["<version>"],
      flags,
    }),
  ].join("\n");
}

export function formatMigrationRepairCommand(input: {
  readonly status: "applied" | "reverted";
  readonly versions: ReadonlyArray<string>;
  readonly flags?: MigrationRepairFlags;
}): string {
  const parts = ["supabase", "migration", "repair"];
  if (input.flags?.local === true) {
    parts.push("--local");
  }
  if (input.flags?.dbUrlEnvVar !== undefined) {
    parts.push("--db-url", `"$${input.flags.dbUrlEnvVar}"`);
  } else if (input.flags?.dbUrlSame === true) {
    parts.push("--db-url", "<same-url>");
  }
  if (input.flags?.projectRef !== undefined) {
    parts.push("--project-ref", input.flags.projectRef);
  }
  parts.push("--status", input.status, ...input.versions);
  return parts.join(" ");
}

export function formatHistoryConflict(input: {
  readonly remoteOnly: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<string>;
  readonly flags?: MigrationRepairFlags;
}): { readonly detail: string; readonly suggestion: string } {
  const remote = input.remoteOnly.join(", ");
  const detail =
    input.pending.length > 0
      ? `Local and remote migration histories have diverged (remote-only: ${remote}; pending: ${input.pending.join(", ")}).`
      : `Remote history has versions with no local files: ${remote}.`;
  return {
    detail,
    suggestion: formatMigrationsPullCommand(input.flags),
  };
}
