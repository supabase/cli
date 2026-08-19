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
  return opts.projectRef !== undefined ? { projectRef: opts.projectRef } : {};
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
  return {
    detail: `Local and remote migration histories have diverged (remote-only: ${input.remoteOnly.join(", ")}; pending: ${input.pending.join(", ")}).`,
    suggestion: formatMigrationRepairCommand({
      status: "reverted",
      versions: input.remoteOnly,
      flags: input.flags,
    }),
  };
}

export function suggestRemoteDriftRepair(input: {
  readonly remoteOnly: ReadonlyArray<string>;
  readonly matchingPrefix: ReadonlyArray<string>;
  readonly flags?: MigrationRepairFlags;
}): string {
  const lines: Array<string> = [];
  if (input.remoteOnly.length > 0) {
    lines.push(
      formatMigrationRepairCommand({
        status: "reverted",
        versions: input.remoteOnly,
        flags: input.flags,
      }),
    );
  }
  if (input.matchingPrefix.length > 0) {
    lines.push(
      formatMigrationRepairCommand({
        status: "applied",
        versions: input.matchingPrefix,
        flags: input.flags,
      }),
    );
  } else {
    lines.push("supabase migrations pull");
  }
  return lines.join("\n");
}
