/**
 * Local Docker resource id derivation, ported from Go's `utils.GetId` /
 * `utils.NetId` / `utils.DbId` (`apps/cli-go/internal/utils/config.go`). Hoisted
 * to `legacy/shared` so both `gen types` and the declarative seam derive the same
 * `supabase_db_<projectId>` / `supabase_network_<projectId>` names when checking
 * whether the local stack is running.
 */

import { basename } from "node:path";

import { legacyViperEnvStringWithProjectFallback } from "../../shared/legacy/legacy-viper-env.ts";

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

/**
 * Go's `GetId` sanitisation: replace invalid runs with `_`, strip leading
 * `_.-`, and cap at 40 chars.
 *
 * Exported because it is not only a container-*naming* concern: Go's
 * `Config.Validate` (`pkg/config/config.go:938-944`) rewrites `c.ProjectId`
 * to this same sanitized form **in place, once, at config-load time** (every
 * `flags.LoadConfig` call ends in `Load` -> `Validate`), and every later use
 * of `Config.ProjectId` — including the Docker LABEL value written by `start`
 * (`internal/utils/docker.go:375`: `config.Labels[CliProjectLabel] =
 * Config.ProjectId`) — reads that already-sanitized singleton. `GetId` itself
 * performs no sanitisation of its own; it just reads the pre-sanitized value.
 * So on the config/env-derived (non-`--project-id`) path, callers building a
 * Docker label FILTER must sanitize too, or a `project_id` like `"my app"`
 * filters on the raw string while `start` labeled the sanitized one and never
 * matches anything (see `legacyCliProjectFilterValue`'s doc comment).
 */
export function legacySanitizeProjectId(src: string) {
  const sanitized = src.replaceAll(INVALID_PROJECT_ID, "_").replace(/^[_.-]+/, "");
  return truncateText(sanitized, MAX_PROJECT_ID_LENGTH);
}

/**
 * `supabase_<suffix>_<sanitizedProjectId>` — the naming scheme shared by every
 * local Docker resource (`utils.GetId`, `apps/cli-go/internal/utils/config.go`).
 * Exported so callers building a single service's container name (e.g. a
 * future `legacy-service-catalog.ts` consumer) don't need to go through
 * {@link legacyServiceContainerIds}'s fixed 13-element array.
 */
export function legacyServiceContainerName(suffix: string, projectId: string): string {
  return `supabase_${suffix}_${legacySanitizeProjectId(projectId)}`;
}

/** `utils.DbId` — the local Postgres container name. */
export function localDbContainerId(projectId: string) {
  return legacyServiceContainerName("db", projectId);
}

/** `utils.NetId` fallback — the default generated docker network name. */
export function localNetworkId(projectId: string) {
  return legacyServiceContainerName("network", projectId);
}

/**
 * `utils.NetId`/`DockerStart`'s network-mode resolution (`apps/cli-go/internal/utils/docker.go:
 * 379-383`, `internal/utils/config.go:62`): an explicit `--network-id` flag wins, then
 * `SUPABASE_NETWORK_ID` — `network-id` is one of the persistent flags Go binds to viper under
 * `SetEnvPrefix("SUPABASE")` + `AutomaticEnv()` (`cmd/root.go:318-334`, same mechanism as
 * `SUPABASE_YES`/`SUPABASE_EXPERIMENTAL`), and `viper.GetString("network-id")` reads the
 * (dotenv-merged) process env fresh at `DockerStart`'s own call site — deep inside container
 * bring-up, well after `Config.Load`'s dotenv pass already ran — unlike `utils.Config.Hostname`,
 * which is fixed once via `GetHostname()` at the `utils` package's `var` init, before `main()`
 * ever runs a command's `Config.Load` (see {@link legacyGetHostname}'s own doc comment for why a
 * project-dotenv-only override does NOT reach that field). Only when both the flag and the env
 * are absent does Go fall back to the generated `supabase_network_<projectId>` name.
 *
 * `db start` and `start` both compute this identically — hoisted here (rather than duplicated in
 * each handler) per the "hoist before you duplicate" rule (`apps/cli/CLAUDE.md`).
 */
export function legacyResolveNetworkId(
  flagValue: string | undefined,
  projectId: string,
  projectEnvValues: Readonly<Record<string, string>>,
): string {
  if (flagValue !== undefined && flagValue.length > 0) return flagValue;
  const envNetworkId = legacyViperEnvStringWithProjectFallback(
    "SUPABASE_NETWORK_ID",
    projectEnvValues,
  );
  if (envNetworkId.length > 0) return envNetworkId;
  return localNetworkId(projectId);
}

/** Go's `utils.CliProjectLabel` (`apps/cli-go/internal/utils/docker.go:59`) — the
 * Docker label every container/volume/network created by `supabase start` carries. */
export const LEGACY_CLI_PROJECT_LABEL = "com.supabase.cli.project";

/**
 * TS-port-only Docker label (no Go equivalent — Go never stages secrets on host disk in
 * the first place, see `legacy-start-secrets-cleanup.ts`'s doc comment) recording the
 * absolute `LegacyCliConfig.workdir` a container was created under, set on every
 * container `start` creates (`container-lifecycle.ts`'s `legacyCreateContainer`).
 *
 * Read back by `legacyListContainerIdsAndNames` (`legacy-docker-lifecycle.ts`) so a later
 * `stop`/`legacyRollbackStart` can reclaim `legacyCleanupStartSecrets`'s staged-secret
 * directory using the CONTAINER's OWN workdir, rather than the caller's own cwd/
 * `--workdir` — those can differ when tearing down another project's containers (e.g.
 * `stop --all`/`stop --project-id <other>`), which would otherwise look in the wrong
 * directory and orphan that project's staged secret files on disk forever.
 */
export const LEGACY_CLI_WORKDIR_LABEL = "com.supabase.cli.workdir";

/**
 * TS-port-only Docker label (no Go equivalent, same reasoning as {@link
 * LEGACY_CLI_WORKDIR_LABEL}) recording the staged-secret directory id for a container
 * created WITHOUT a name (`container-lifecycle.ts`'s `legacyCreateContainer` fallback path
 * — today, only the `db diff`/`db pull` shadow database, see
 * `db-bootstrap/shadow-database.ts`'s `legacyCreateShadowDatabase`). A named container's
 * secret directory is always `<containerName>` and needs no separate label — Docker hands
 * that name straight back via `docker ps`. An UNNAMED container's secret directory is a
 * randomized `shadow-<uuid>` known only to the process that created it (see
 * `legacyCreateShadowDatabase`'s own doc comment for why it's randomized rather than
 * fixed); if that process is killed before its own finalizer
 * (`legacyRemoveShadowDatabase`) runs, the container becomes a labeled orphan that a later
 * `stop`'s project-label-filtered reaping WILL remove, but with no way to recover the
 * matching secret-dir id from `container.name` (Docker's own auto-generated name, which
 * bears no relation to it) — leaving the staged plaintext pgsodium root key on disk
 * indefinitely. Stamping this label at creation time gives orphan cleanup a way to recover
 * it anyway: read back by {@link legacyListContainerIdsAndNames}
 * (`legacy-docker-lifecycle.ts`), consumed by `legacyCleanupStartSecrets`
 * (`legacy-start-secrets-cleanup.ts`), which prefers this label's value over `container.name`
 * whenever it's present (review: PRRT_kwDOErm0O86W8ZYt).
 */
export const LEGACY_CLI_SECRET_DIR_LABEL = "com.supabase.cli.secret-dir";

/**
 * Go's `utils.GetDockerIds()` (`apps/cli-go/internal/utils/config.go:82-98`) — the
 * 13 service container ids (excludes `db`, `network`, and the `differ` shadow
 * container, which are not part of the "expected running services" set). Order and
 * alias-name strings are taken verbatim from `config.go:36-49,61-79`.
 */
export function legacyServiceContainerIds(projectId: string): ReadonlyArray<string> {
  return [
    legacyServiceContainerName("kong", projectId),
    legacyServiceContainerName("auth", projectId),
    legacyServiceContainerName("inbucket", projectId),
    legacyServiceContainerName("realtime", projectId),
    legacyServiceContainerName("rest", projectId),
    legacyServiceContainerName("storage", projectId),
    legacyServiceContainerName("imgproxy", projectId),
    legacyServiceContainerName("pg_meta", projectId),
    legacyServiceContainerName("studio", projectId),
    legacyServiceContainerName("edge_runtime", projectId),
    legacyServiceContainerName("analytics", projectId),
    legacyServiceContainerName("vector", projectId),
    legacyServiceContainerName("pooler", projectId),
  ];
}

/**
 * Go's `utils.CliProjectFilter` (`apps/cli-go/internal/utils/docker.go:148-156`) —
 * the value that follows `--filter label=` on the `docker`/`podman` CLI. An empty
 * `projectId` (Go's `--all` path) filters on the bare label across every project.
 *
 * This function itself does not sanitize — by design, it's a pure pass-through.
 * The caller is responsible for sanitizing `projectId` with
 * {@link legacySanitizeProjectId} on the config/env-derived (default) path
 * BEFORE calling this, matching Go's `Config.Validate` sanitizing the
 * `Config.ProjectId` singleton once at config-load time so every later
 * reader — including the Docker LABEL `start` writes — sees the same
 * sanitized string. An explicit `--project-id <value>` (where one exists,
 * e.g. `stop`) is Go's one exception: it assigns straight to
 * `Config.ProjectId` without going through `Validate`
 * (`apps/cli-go/internal/stop/stop.go:19-20`), so that path must stay raw/
 * unsanitized to match. There is also no injection risk either way: this
 * value is always passed as a single argv element to a spawned process
 * (never through a shell), so a malformed value can only make Docker's own
 * filter parsing reject it or match nothing — it cannot break out into
 * another command.
 */
export function legacyCliProjectFilterValue(projectId: string): string {
  if (projectId.length === 0) return LEGACY_CLI_PROJECT_LABEL;
  return `${LEGACY_CLI_PROJECT_LABEL}=${projectId}`;
}
