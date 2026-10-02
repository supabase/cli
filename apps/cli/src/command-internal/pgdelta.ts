import { Option } from "effect";

import { resolveLocalProjectId, sanitizeProjectId } from "./docker-ids.ts";

/**
 * Ambient inputs shared by the pg-delta and migra diff workflows: the project id
 * (for the `supabase_edge_runtime_<id>` Deno-cache volume migra's edge-runtime
 * run binds), the working directory, the effective `edge_runtime.deno_version`,
 * and the project's parsed `supabase/.env`.
 */
export interface PgDeltaContext {
  readonly projectId: string;
  readonly cwd: string;
  /**
   * Effective `edge_runtime.deno_version` from the (remote-merged on `--linked`) config,
   * forwarded to the edge-runtime container so migra runs under the configured Deno image.
   */
  readonly denoVersion: number;
  /** The project's parsed `supabase/.env` (`readDbToml`'s `projectEnv`). */
  readonly projectEnv: Readonly<Record<string, string>>;
}

/**
 * Resolves {@link PgDeltaContext.projectId} — not `CommandSettings.projectId` alone, which is
 * env-only and resolves to `""` for a project relying on config.toml's `project_id` or the
 * workdir-basename default, mounting the wrong `supabase_edge_runtime_` Deno-cache volume.
 * Shared by every pg-delta context builder (`db diff`, `db pull`, declarative generate/sync).
 *
 * When a matched `[remotes.<ref>]` block already resolved its own `project_id` into
 * `toml.projectId`, the raw `cliProjectId` argument is suppressed entirely — otherwise an
 * unrelated ambient `SUPABASE_PROJECT_ID` could win back over the matched remote's id.
 */
export function resolvePgDeltaProjectId(
  cliProjectId: Option.Option<string>,
  toml: { readonly projectId: Option.Option<string>; readonly appliedRemote: string | undefined },
  workdir: string,
): string {
  return sanitizeProjectId(
    resolveLocalProjectId(
      toml.appliedRemote !== undefined ? undefined : Option.getOrUndefined(cliProjectId),
      Option.getOrUndefined(toml.projectId),
      workdir,
    ),
  );
}

export function isPostgresURL(ref: string): boolean {
  return ref.startsWith("postgres://") || ref.startsWith("postgresql://");
}

export function edgeRuntimeId(projectId: string): string {
  return `supabase_edge_runtime_${projectId}`;
}

/** Recognizes `PGDELTA_DEBUG=1`/`true`/`yes` (case-insensitive). */
export function isPgDeltaDebugEnabled(): boolean {
  const value = (process.env["PGDELTA_DEBUG"] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
