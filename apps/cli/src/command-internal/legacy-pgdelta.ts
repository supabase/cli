import { Option } from "effect";

import { legacyResolveLocalProjectId, legacySanitizeProjectId } from "./legacy-docker-ids.ts";

/** A per-file payload from pg-delta declarative export. Mirrors Go's `DeclarativeFile`. */
interface LegacyDeclarativeFile {
  readonly path: string;
  readonly order: number;
  readonly statements: number;
  readonly sql: string;
}

/** The declarative export envelope. Mirrors Go's `DeclarativeOutput`. */
export interface LegacyDeclarativeOutput {
  readonly version: number;
  readonly mode: string;
  readonly files: ReadonlyArray<LegacyDeclarativeFile>;
}

/**
 * Ambient inputs shared by the pg-delta and migra diff workflows: the project id
 * (for the `supabase_edge_runtime_<id>` Deno-cache volume migra's edge-runtime
 * run binds), the working directory, the effective `edge_runtime.deno_version`,
 * and the project's parsed `supabase/.env`.
 */
export interface LegacyPgDeltaContext {
  readonly projectId: string;
  readonly cwd: string;
  /**
   * Effective `edge_runtime.deno_version` from the (remote-merged on `--linked`)
   * config, forwarded to the edge-runtime container so migra runs under the
   * configured Deno image. Mirrors Go, which resolves the image from the loaded
   * config the command operates on rather than the base `config.toml`.
   */
  readonly denoVersion: number;
  /** The project's parsed `supabase/.env` (`legacyReadDbToml`'s `projectEnv`). */
  readonly projectEnv: Readonly<Record<string, string>>;
}

/**
 * Resolves {@link LegacyPgDeltaContext.projectId}: Go's `Config.ProjectId` singleton
 * (`SUPABASE_PROJECT_ID` env → config.toml's `project_id` → sanitized workdir basename,
 * `pkg/config/config.go:563-570` + `Validate` :989-996), sanitized the same way
 * `UpdateDockerIds` derives `EdgeRuntimeId` from it (`internal/utils/config.go:57-76`) —
 * NOT `LegacyCliSettings.projectId` alone, which is env-only and resolves to `""` for a
 * project that relies on config.toml's `project_id` or the workdir-basename default,
 * mounting the WRONG `supabase_edge_runtime_` Deno-cache volume (review:
 * PRRT_kwDOErm0O86XAlIw). Hoisted here — the single home for every pg-delta context
 * builder (`db diff`, `db pull`, `db schema declarative generate`/`sync`) — per
 * `apps/cli/CLAUDE.md`'s "Hoist Before You Duplicate" rule.
 *
 * `toml.appliedRemote !== undefined` suppresses the raw `cliProjectId` argument entirely:
 * `toml.projectId` already reflects the matched `[remotes.<ref>]` block's own `project_id`
 * at viper's override tier (`legacyReadDbToml`'s `remoteOverrideKeys.has("project_id")`
 * gate, review: PRRT_kwDOErm0O86XHGDL) — but `legacyResolveLocalProjectId` tries its FIRST
 * argument before its second, so passing the raw, ungated `cliProjectId` through would let
 * an unrelated ambient `SUPABASE_PROJECT_ID` win back over the matched remote's own id,
 * mounting the wrong Deno-cache volume for a linked run. Mirrors the same
 * suppression `legacy-local-project-context.ts`'s own `legacyLoadLocalProjectContext`
 * already applies (review: PRRT_kwDOErm0O86XI1w8).
 */
export function legacyResolvePgDeltaProjectId(
  cliProjectId: Option.Option<string>,
  toml: { readonly projectId: Option.Option<string>; readonly appliedRemote: string | undefined },
  workdir: string,
): string {
  return legacySanitizeProjectId(
    legacyResolveLocalProjectId(
      toml.appliedRemote !== undefined ? undefined : Option.getOrUndefined(cliProjectId),
      Option.getOrUndefined(toml.projectId),
      workdir,
    ),
  );
}

/** Mirrors Go's `isPostgresURL` (`internal/db/diff/pgdelta.go:46`). */
export function legacyIsPostgresURL(ref: string): boolean {
  return ref.startsWith("postgres://") || ref.startsWith("postgresql://");
}

/** Mirrors Go's `utils.EdgeRuntimeId` = `GetId("edge_runtime")` = `supabase_edge_runtime_<projectId>`. */
export function legacyEdgeRuntimeId(projectId: string): string {
  return `supabase_edge_runtime_${projectId}`;
}

/** Mirrors Go's `IsPgDeltaDebugEnabled` (`internal/db/diff/pgdelta_debug.go:11`). */
export function legacyIsPgDeltaDebugEnabled(): boolean {
  const value = (process.env["PGDELTA_DEBUG"] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
