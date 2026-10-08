import { Effect, Option } from "effect";

import { CliConfigKeys } from "../config/cli-config-keys.ts";
import type { CliConfigSnapshot } from "../config/cli-config-values.service.ts";
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
 * The local Docker project id from the config snapshot: `SUPABASE_PROJECT_ID`, then the matched
 * remote's or base `project_id`, then the sanitized workdir basename. The registry types the key as
 * an `Option`, but its workdir default makes it always a string.
 */
export const snapshotLocalProjectId = (snapshot: CliConfigSnapshot) =>
  snapshot
    .get(CliConfigKeys.projectId)
    .pipe(
      Effect.map(({ value }) =>
        typeof value === "string" ? value : Option.getOrElse(value, () => ""),
      ),
    );

/** Resolves {@link PgDeltaContext.projectId} from the config snapshot. */
export const pgDeltaProjectId = (snapshot: CliConfigSnapshot) =>
  snapshotLocalProjectId(snapshot).pipe(Effect.map(sanitizeProjectId));

/**
 * Resolves the project id for callers that only hold a parsed `DbTomlValues`; `SUPABASE_PROJECT_ID`
 * beats the config's `project_id`, matched remote included.
 */
export function resolvePgDeltaProjectId(
  cliProjectId: Option.Option<string>,
  toml: { readonly projectId: Option.Option<string> },
  workdir: string,
): string {
  return sanitizeProjectId(
    resolveLocalProjectId(
      Option.getOrUndefined(cliProjectId),
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
