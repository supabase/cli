/**
 * Local Docker resource id derivation, ported from `utils.GetId` /
 * `utils.NetId` / `utils.DbId`. Hoisted
 * to `command-internal` so both `gen types` and the declarative seam derive the same
 * `supabase_db_<projectId>` / `supabase_network_<projectId>` names when checking
 * whether the local stack is running.
 */

import { basename } from "node:path";

/**
 * Resolve the project id Go feeds into `utils.DbId`/`utils.NetId`. viper sets
 * `Config.ProjectId` from config.toml's `project_id`, then `AutomaticEnv` overrides it
 * with `SUPABASE_PROJECT_ID`; when both are absent Go falls back to the working
 * directory basename (`utils.Config.ProjectId` default) — UNLESS a `--project-ref`
 * was resolved for this invocation, in which case `flags.LoadConfig` pre-sets
 * `Config.ProjectId = ProjectRef` before ever merging the file,
 * so `Eject` only reaches the basename fallback
 * when that default is itself empty. `projectRefDefault` is `undefined` for
 * `start`/`stop`/`status`, which have no such flag. So the full precedence is
 * `SUPABASE_PROJECT_ID` → config.toml `project_id` → `--project-ref` → workdir basename.
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
 * `GetId` sanitisation: replace invalid runs with `_`, strip leading
 * `_.-`, and cap at 40 chars.
 *
 * Exported because it is not only a container-*naming* concern: config
 * validation rewrites the resolved project id
 * to this same sanitized form **in place, once, at config-load time** (every
 * `flags.LoadConfig` call ends in `Load` -> `Validate`), and every later use
 * of that project id — including the Docker LABEL value written by `start`
 * (`config.Labels[CliProjectLabel] =
 * Config.ProjectId`) — reads that already-sanitized singleton. `GetId` itself
 * performs no sanitisation of its own; it just reads the pre-sanitized value.
 * So on the config/env-derived (non-`--project-id`) path, callers building a
 * Docker label FILTER must sanitize too, or a `project_id` like `"my app"`
 * filters on the raw string while `start` labeled the sanitized one and never
 * matches anything (see `cliProjectFilterValue`'s doc comment).
 */
export function sanitizeProjectId(src: string) {
  const sanitized = src.replaceAll(INVALID_PROJECT_ID, "_").replace(/^[_.-]+/, "");
  return truncateText(sanitized, MAX_PROJECT_ID_LENGTH);
}

/**
 * `supabase_<suffix>_<sanitizedProjectId>` — the naming scheme shared by every
 * local Docker resource (`utils.GetId`).
 * Exported so callers building a single service's container name (e.g. a
 * future `service-catalog.ts` consumer) don't need to go through
 * {@link serviceContainerIds}'s fixed 13-element array.
 */
export function serviceContainerName(suffix: string, projectId: string): string {
  return `supabase_${suffix}_${sanitizeProjectId(projectId)}`;
}

/** `utils.DbId` — the local Postgres container name. */
export function localDbContainerId(projectId: string) {
  return serviceContainerName("db", projectId);
}

/** `utils.NetId` fallback — the default generated docker network name. */
export function localNetworkId(projectId: string) {
  return serviceContainerName("network", projectId);
}

// `utils.NetId`/`DockerStart`'s network-mode resolution has ONE home:
// `resolveDockerNetworkMode` (`shared/functions/functions-docker.ts`). An
// earlier `resolveNetworkId` here fell through to `SUPABASE_NETWORK_ID`
// on an explicit-but-empty `--network-id=`, which viper's `find()` never does
// (a `Changed` pflag resolves BEFORE the env branch — see the shared helper's
// doc comment); `start`/`db start` now call the shared helper directly
// (review round on CLI-1963).

/** `utils.CliProjectLabel` — the
 * Docker label every container/volume/network created by `supabase start` carries. */
export const CLI_PROJECT_LABEL = "com.supabase.cli.project";

/**
 * TS-port-only Docker label (no Go equivalent — Go never stages secrets on host disk in
 * the first place, see `start-secrets-cleanup.ts`'s doc comment) recording the
 * absolute `CommandSettings.workdir` a container was created under, set on every
 * container `start` creates (`container-lifecycle.ts`'s `createContainer`).
 *
 * Read back by `listContainerIdsAndNames` (`docker-lifecycle.ts`) so a later
 * `stop`/`rollbackStart` can reclaim `cleanupStartSecrets`'s staged-secret
 * directory using the CONTAINER's OWN workdir, rather than the caller's own cwd/
 * `--workdir` — those can differ when tearing down another project's containers (e.g.
 * `stop --all`/`stop --project-id <other>`), which would otherwise look in the wrong
 * directory and orphan that project's staged secret files on disk forever.
 */
export const CLI_WORKDIR_LABEL = "com.supabase.cli.workdir";

/**
 * `utils.GetDockerIds()` — the
 * 13 service container ids (excludes `db`, `network`, and the `differ` shadow
 * container, which are not part of the "expected running services" set). Order and
 * alias-name strings are taken verbatim from the established naming scheme.
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
 * `utils.CliProjectFilter` —
 * the value that follows `--filter label=` on the `docker`/`podman` CLI. An empty
 * `projectId` (`--all` path) filters on the bare label across every project.
 *
 * This function itself does not sanitize — by design, it's a pure pass-through.
 * The caller is responsible for sanitizing `projectId` with
 * {@link sanitizeProjectId} on the config/env-derived (default) path
 * BEFORE calling this, matching `Config.Validate` sanitizing the
 * `Config.ProjectId` singleton once at config-load time so every later
 * reader — including the Docker LABEL `start` writes — sees the same
 * sanitized string. An explicit `--project-id <value>` (where one exists,
 * e.g. `stop`) is the one exception: it assigns straight to
 * the project id without going through validation, so that path must stay raw/
 * unsanitized to match. There is also no injection risk either way: this
 * value is always passed as a single argv element to a spawned process
 * (never through a shell), so a malformed value can only make Docker's own
 * filter parsing reject it or match nothing — it cannot break out into
 * another command.
 */
export function cliProjectFilterValue(projectId: string): string {
  if (projectId.length === 0) return CLI_PROJECT_LABEL;
  return `${CLI_PROJECT_LABEL}=${projectId}`;
}
