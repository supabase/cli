import type { ProjectConfig } from "@supabase/config";

/**
 * Outcome of pushing a single service's config to the linked project.
 *
 * `service` uses dotted keys mirroring `config.toml` paths (`api`,
 * `db.settings`, `db.network_restrictions`, `db.ssl_enforcement`, `auth`,
 * `storage`, `experimental.webhooks`). Status:
 *   - `updated`     — a diff existed, the user kept it, the PATCH/PUT/POST ran.
 *   - `up_to_date`  — remote already matched local (no diff, no write).
 *   - `skipped`     — a diff existed but the user declined the prompt.
 *   - `disabled`    — the service's local gate was off, so it was not touched.
 *
 * Go has no machine output for `config push`; this shape backs the TS
 * `json` / `stream-json` modes only.
 */
type LegacyConfigPushServiceStatus = "updated" | "up_to_date" | "skipped" | "disabled";

export interface LegacyConfigPushServiceResult {
  readonly service: string;
  readonly status: LegacyConfigPushServiceStatus;
}

/**
 * The resolved config to push: the base config (with any matching remote
 * override applied) plus the effective project ref.
 */
export interface LegacyResolvedRemoteConfig {
  readonly projectId: string;
  readonly config: ProjectConfig;
}

/**
 * Whether any `[remotes.<name>]` block declares `project_id == ref`.
 *
 * Go's `config.GetRemoteByProjectRef` (`pkg/config/config.go:1652`) applies the
 * matching remote block over the base config via `mergeRemoteConfig` (a
 * subset-only deep merge performed at load time). `@supabase/config`'s
 * `loadProjectConfig` does not do that merge, and the decoded `remotes[name]`
 * sections carry full schema defaults — so applying one verbatim would reset
 * every field the block does not override to its default and silently overwrite
 * remote config the user never intended to touch. Until a faithful raw-TOML
 * subset merge is implemented, the handler aborts when this returns true rather
 * than corrupting the remote. The dominant (and only Go-tested) path has no
 * `[remotes.*]` block, so this returns false and push proceeds normally.
 */
export function matchesRemoteProjectRef(config: ProjectConfig, ref: string): boolean {
  return Object.values(config.remotes ?? {}).some((remote) => remote.project_id === ref);
}

/**
 * Resolves the config to push: the base config stamped with the effective
 * project ref. Callers must reject `[remotes.*]` matches up front via
 * {@link matchesRemoteProjectRef}; see that function for why the override is not
 * applied here.
 */
export function resolveRemoteByProjectRef(
  config: ProjectConfig,
  ref: string,
): LegacyResolvedRemoteConfig {
  return { projectId: ref, config };
}
