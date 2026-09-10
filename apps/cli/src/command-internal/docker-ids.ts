/**
 * Local Docker resource id derivation shared by `gen types` and the declarative seam, so both
 * agree on `supabase_db_<projectId>` / `supabase_network_<projectId>` names when checking whether
 * the local stack is running.
 */

import { basename } from "node:path";

/**
 * Resolves the local project id used to derive Docker resource names.
 *
 * Precedence: `SUPABASE_PROJECT_ID` env var, then config.toml's `project_id`, then
 * `--project-ref` (when the command accepts one), then the working directory's basename.
 */
export function resolveLocalProjectId(
  envProjectId: string | undefined,
  tomlProjectId: string | undefined,
  workdir: string,
  projectRefDefault?: string,
): string {
  if (envProjectId !== undefined && envProjectId.length > 0) return envProjectId;
  if (tomlProjectId !== undefined && tomlProjectId.length > 0) return tomlProjectId;
  if (projectRefDefault !== undefined && projectRefDefault.length > 0) return projectRefDefault;
  return basename(workdir);
}

const INVALID_PROJECT_ID = /[^a-zA-Z0-9_.-]+/g;
const MAX_PROJECT_ID_LENGTH = 40;

function truncateText(text: string, maxLength: number) {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * Sanitizes a project id for use in container/network names: replaces invalid character runs
 * with `_`, strips leading `_.-`, and caps the result at 40 characters.
 *
 * Exported separately from {@link serviceContainerName} because a Docker label filter built
 * from a project id must be sanitized the same way, or a `project_id` like `"my app"` won't
 * match the label `start` wrote (see {@link cliProjectFilterValue}).
 */
export function sanitizeProjectId(src: string) {
  const sanitized = src.replaceAll(INVALID_PROJECT_ID, "_").replace(/^[_.-]+/, "");
  return truncateText(sanitized, MAX_PROJECT_ID_LENGTH);
}

/** `supabase_<suffix>_<sanitizedProjectId>` — the naming scheme for local Docker resources. */
export function serviceContainerName(suffix: string, projectId: string): string {
  return `supabase_${suffix}_${sanitizeProjectId(projectId)}`;
}

/** The local Postgres container name. */
export function localDbContainerId(projectId: string) {
  return serviceContainerName("db", projectId);
}

/** The default generated Docker network name. */
export function localNetworkId(projectId: string) {
  return serviceContainerName("network", projectId);
}

/** The Docker label every container/volume/network created by `supabase start` carries. */
export const CLI_PROJECT_LABEL = "com.supabase.cli.project";

/**
 * Docker label recording the absolute workdir a container was created under, set when `start`
 * creates it. `stop`/rollback read this label — rather than the caller's own cwd — to reclaim
 * that project's staged secrets, since the two can differ when tearing down another project's
 * stack.
 */
export const CLI_WORKDIR_LABEL = "com.supabase.cli.workdir";

/**
 * The 13 service container ids checked as "running", excluding `db`, `network`, and the
 * `differ` shadow container.
 */
export function serviceContainerIds(projectId: string): ReadonlyArray<string> {
  return [
    serviceContainerName("kong", projectId),
    serviceContainerName("auth", projectId),
    serviceContainerName("inbucket", projectId),
    serviceContainerName("realtime", projectId),
    serviceContainerName("rest", projectId),
    serviceContainerName("storage", projectId),
    serviceContainerName("imgproxy", projectId),
    serviceContainerName("pg_meta", projectId),
    serviceContainerName("studio", projectId),
    serviceContainerName("edge_runtime", projectId),
    serviceContainerName("analytics", projectId),
    serviceContainerName("vector", projectId),
    serviceContainerName("pooler", projectId),
  ];
}

/**
 * The value for `--filter label=` on a `docker`/`podman` invocation. An empty `projectId`
 * filters on the bare label across every project.
 *
 * Does not sanitize `projectId` — the config/env-derived path must call
 * {@link sanitizeProjectId} first to match the label `start` wrote, while an explicit
 * `--project-id` value stays raw on purpose.
 */
export function cliProjectFilterValue(projectId: string): string {
  if (projectId.length === 0) return CLI_PROJECT_LABEL;
  return `${CLI_PROJECT_LABEL}=${projectId}`;
}
