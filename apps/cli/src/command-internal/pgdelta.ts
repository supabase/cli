import { Effect } from "effect";

import { envValue } from "../shared/config/env-option.ts";

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

export function isPostgresURL(ref: string): boolean {
  return ref.startsWith("postgres://") || ref.startsWith("postgresql://");
}

export function edgeRuntimeId(projectId: string): string {
  return `supabase_edge_runtime_${projectId}`;
}

/** Recognizes `PGDELTA_DEBUG=1`/`true`/`yes` (case-insensitive). */
export const isPgDeltaDebugEnabled: Effect.Effect<boolean> = Effect.map(
  envValue("PGDELTA_DEBUG"),
  (raw) => {
    const value = (raw ?? "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes";
  },
);
