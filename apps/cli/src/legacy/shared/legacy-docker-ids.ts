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
