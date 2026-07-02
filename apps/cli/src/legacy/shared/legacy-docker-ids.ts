/**
 * Local Docker resource id derivation, ported from Go's `utils.GetId` /
 * `utils.NetId` / `utils.DbId` (`apps/cli-go/internal/utils/config.go`). Hoisted
 * to `legacy/shared` so both `gen types` and the declarative seam derive the same
 * `supabase_db_<projectId>` / `supabase_network_<projectId>` names when checking
 * whether the local stack is running.
 */

import { basename } from "node:path";

/**
 * Resolve the project id Go feeds into `utils.DbId`/`utils.NetId`. viper sets
 * `Config.ProjectId` from config.toml's `project_id`, then `AutomaticEnv` overrides it
 * with `SUPABASE_PROJECT_ID`; when both are absent Go falls back to the working
 * directory basename (`utils.Config.ProjectId` default). So the precedence is
 * `SUPABASE_PROJECT_ID` → config.toml `project_id` → workdir basename.
 */
export function legacyResolveLocalProjectId(
  envProjectId: string | undefined,
  tomlProjectId: string | undefined,
  workdir: string,
): string {
  if (envProjectId !== undefined && envProjectId.length > 0) return envProjectId;
  if (tomlProjectId !== undefined && tomlProjectId.length > 0) return tomlProjectId;
  return basename(workdir);
}

const INVALID_PROJECT_ID = /[^a-zA-Z0-9_.-]+/g;
const MAX_PROJECT_ID_LENGTH = 40;

function truncateText(text: string, maxLength: number) {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** Go's `GetId` sanitisation: replace invalid runs with `_`, strip leading
 * `_.-`, and cap at 40 chars. */
function sanitizeProjectId(src: string) {
  const sanitized = src.replaceAll(INVALID_PROJECT_ID, "_").replace(/^[_.-]+/, "");
  return truncateText(sanitized, MAX_PROJECT_ID_LENGTH);
}

function localDockerId(name: string, projectId: string) {
  return `supabase_${name}_${sanitizeProjectId(projectId)}`;
}

/** `utils.DbId` — the local Postgres container name. */
export function localDbContainerId(projectId: string) {
  return localDockerId("db", projectId);
}

/** `utils.NetId` fallback — the default generated docker network name. */
export function localNetworkId(projectId: string) {
  return localDockerId("network", projectId);
}

/** Go's `utils.CliProjectLabel` (`apps/cli-go/internal/utils/docker.go:59`) — the
 * Docker label every container/volume/network created by `supabase start` carries. */
export const LEGACY_CLI_PROJECT_LABEL = "com.supabase.cli.project";

/**
 * Go's `utils.GetDockerIds()` (`apps/cli-go/internal/utils/config.go:82-98`) — the
 * 13 service container ids (excludes `db`, `network`, and the `differ` shadow
 * container, which are not part of the "expected running services" set). Order and
 * alias-name strings are taken verbatim from `config.go:36-49,61-79`.
 */
export function legacyServiceContainerIds(projectId: string): ReadonlyArray<string> {
  return [
    localDockerId("kong", projectId),
    localDockerId("auth", projectId),
    localDockerId("inbucket", projectId),
    localDockerId("realtime", projectId),
    localDockerId("rest", projectId),
    localDockerId("storage", projectId),
    localDockerId("imgproxy", projectId),
    localDockerId("pg_meta", projectId),
    localDockerId("studio", projectId),
    localDockerId("edge_runtime", projectId),
    localDockerId("analytics", projectId),
    localDockerId("vector", projectId),
    localDockerId("pooler", projectId),
  ];
}

/**
 * Go's `utils.CliProjectFilter` (`apps/cli-go/internal/utils/docker.go:148-156`) —
 * the value that follows `--filter label=` on the `docker`/`podman` CLI. An empty
 * `projectId` (Go's `--all` path) filters on the bare label across every project.
 *
 * Deliberately unsanitized, matching Go exactly: `CliProjectFilter` interpolates
 * `projectId` into the filter string raw, with none of `GetId`'s (this file's
 * `sanitizeProjectId`) character-stripping — that sanitization only applies to
 * Go's own generated container *names*, never to a user-supplied `--project-id`
 * filter value. There is no injection risk from skipping it here: this value is
 * always passed as a single argv element to a spawned process (never through a
 * shell), so a malformed value can only make Docker's own filter parsing reject
 * it or match nothing — it cannot break out into another command.
 */
export function legacyCliProjectFilterValue(projectId: string): string {
  if (projectId.length === 0) return LEGACY_CLI_PROJECT_LABEL;
  return `${LEGACY_CLI_PROJECT_LABEL}=${projectId}`;
}
