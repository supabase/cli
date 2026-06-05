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
 * Port of Go's `config.GetRemoteByProjectRef` (`pkg/config/config.go:1652`).
 *
 * Go applies the `[remotes.<name>]` override at config **load** time (it sets
 * `ProjectId = ref` before `Load`, and `mergeRemoteConfig` deep-merges the
 * matching remote's keys over the base). `GetRemoteByProjectRef` then just
 * clones the already-merged base and stamps `ProjectId = ref`; when no remote
 * matches it returns the base unchanged (the caller swallows the error and uses
 * the base with `ProjectId = ref`).
 *
 * `@supabase/config`'s `loadProjectConfig` does not do the load-time remote
 * merge, so we apply it here against the decoded config.
 *
 * KNOWN LIMITATION: the decoded `remotes[name]` sections carry schema defaults,
 * so a remote that only sets a subset of a service's fields will, when matched,
 * reset that service's other fields to their defaults rather than preserving
 * the base file's values. The dominant (and only Go-tested) path has no
 * `[remotes.*]` block, where this override is a no-op. Faithful subset-only
 * merge requires a raw-TOML pre-decode merge and is tracked as a residual gap.
 */
export function resolveRemoteByProjectRef(
  config: ProjectConfig,
  ref: string,
): LegacyResolvedRemoteConfig {
  for (const [, remote] of Object.entries(config.remotes ?? {})) {
    if (remote.project_id === ref) {
      return {
        projectId: ref,
        config: {
          ...config,
          api: remote.api,
          db: remote.db,
          auth: remote.auth,
          storage: remote.storage,
          experimental: remote.experimental,
        },
      };
    }
  }
  return { projectId: ref, config };
}
