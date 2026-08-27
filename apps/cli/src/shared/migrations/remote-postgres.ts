import { Effect, FileSystem, Option, Path } from "effect";
import type { Pool } from "pg";
import type { DatabaseTarget } from "../database/database-target.ts";
import { Output } from "../output/output.service.ts";
import { SchemaEngineError } from "../schema/schema-errors.ts";
import { SchemaWorkspace } from "../schema/schema-workspace.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

const LOCAL_MAJOR_RESET_NEXT = "supabase db reset";

export function formatShadowMajorAlignedMessage(
  remoteMajor: number,
  previousMajor: number,
): string {
  return `Shadow major is now ${remoteMajor} (was ${previousMajor}). The running local database is still ${previousMajor}. Next: ${LOCAL_MAJOR_RESET_NEXT}`;
}

export function parsePostgresMajor(serverVersion: string | undefined): number | undefined {
  if (serverVersion === undefined) return undefined;
  const match = /^(\d+)/u.exec(serverVersion.trim());
  if (match?.[1] === undefined) return undefined;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : undefined;
}

export function parseConfigPostgresMajor(toml: string): number | undefined {
  const match = /^\s*major_version\s*=\s*(\d+)/mu.exec(toml);
  if (match?.[1] === undefined) return undefined;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : undefined;
}

export function alignConfigPostgresMajor(
  toml: string,
  remoteMajor: number,
): { readonly toml: string; readonly previousMajor: number } | undefined {
  const previousMajor = parseConfigPostgresMajor(toml);
  if (previousMajor === undefined || previousMajor === remoteMajor) return undefined;
  const next = toml.replace(/^(\s*major_version\s*=\s*)\d+/mu, `$1${remoteMajor}`);
  if (next === toml) return undefined;
  return { toml: next, previousMajor };
}

export function generateLocalShadowBanner(major: number | undefined): string {
  const pg = major === undefined ? "Postgres" : `PG ${major}`;
  return `Compared declarations vs migration replay on a local ${pg} shadow, not the linked project.`;
}

export const readConfigPostgresMajor = Effect.fnUntraced(function* () {
  const workspace = yield* Effect.serviceOption(SchemaWorkspace);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  if (Option.isNone(workspace) || Option.isNone(fs) || Option.isNone(path)) {
    return undefined;
  }
  const configPath = path.value.join(
    path.value.dirname(workspace.value.migrationsDir),
    "config.toml",
  );
  const toml = yield* fs.value.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  return parseConfigPostgresMajor(toml);
});

export const assertLocalPostgresMajorMatchesConfig = Effect.fnUntraced(function* (pool: Pool) {
  const runner = yield* MigrationRunner;
  const liveMajor = parsePostgresMajor(yield* runner.showServerVersion(pool));
  const configMajor = yield* readConfigPostgresMajor();
  if (liveMajor === undefined || configMajor === undefined || liveMajor === configMajor) {
    return;
  }
  return yield* new SchemaEngineError({
    detail: `Local database is PostgreSQL ${liveMajor}; config.toml major_version is ${configMajor}.`,
    suggestion: `Run \`${LOCAL_MAJOR_RESET_NEXT}\` so the local container matches config.toml, then retry.`,
  });
});

export const warnIfRemotePostgresMajorMismatch = Effect.fnUntraced(function* (
  pool: Pool,
  target: DatabaseTarget,
) {
  if (target.kind === "local") return;
  const runner = yield* Effect.serviceOption(MigrationRunner);
  const output = yield* Effect.serviceOption(Output);
  if (Option.isNone(runner) || Option.isNone(output)) return;
  const remoteVersion = yield* runner.value.showServerVersion(pool);
  const remoteMajor = parsePostgresMajor(remoteVersion);
  const localMajor = yield* readConfigPostgresMajor();
  if (remoteMajor === undefined || localMajor === undefined || remoteMajor === localMajor) {
    return;
  }
  yield* output.value.warn(
    `config.toml major_version is ${localMajor}; the remote database is PostgreSQL ${remoteMajor} (${remoteVersion}). Continuing.`,
  );
});
