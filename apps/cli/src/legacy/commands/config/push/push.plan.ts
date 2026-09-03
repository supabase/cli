/**
 * Pushable-path registry and per-resource grouping for `config push`.
 *
 * `diffProjectConfig`'s `changeSet.changes` can only contain paths the
 * `@supabase/config` mapping registry knows about (non-secret rows). This
 * module routes each such path to the v1 write endpoint that can express it
 * (a "resource"), or classifies it as declared-but-unwritable ("unsupported")
 * when no v1 field exists for it at all.
 */

import type { ConfigChange, ConfigChangeSet } from "@supabase/config/internal";

export type LegacyPushResource =
  | "api"
  | "db.settings"
  | "db.network_restrictions"
  | "db.ssl_enforcement"
  | "auth"
  | "storage";

/** Push order — the order `config push` has always processed its services in. */
export const LEGACY_PUSH_RESOURCES: ReadonlyArray<LegacyPushResource> = [
  "api",
  "db.settings",
  "db.network_restrictions",
  "db.ssl_enforcement",
  "auth",
  "storage",
];

/**
 * ProjectConfig path prefixes with no v1 write path — surfaced (in the
 * `unsupported` note/payload field), never pushed. Every leaf under one of
 * these prefixes is unsupported: `db.major_version`;
 * `db.pooler.{pool_mode,default_pool_size,max_client_conn}`;
 * `auth.oauth_server.{enabled,allow_dynamic_registration,authorization_url_path}`.
 */
export const LEGACY_PUSH_UNSUPPORTED_PREFIXES: ReadonlyArray<ReadonlyArray<string>> = [
  ["db", "major_version"],
  ["db", "pooler"],
  ["auth", "oauth_server"],
];

/** Longest-registered-prefix routing target for a comparable config path. */
const LEGACY_PUSH_RESOURCE_PREFIXES: ReadonlyArray<{
  readonly prefix: ReadonlyArray<string>;
  readonly resource: LegacyPushResource;
}> = [
  { prefix: ["db", "settings"], resource: "db.settings" },
  { prefix: ["db", "network_restrictions"], resource: "db.network_restrictions" },
  { prefix: ["db", "ssl_enforcement"], resource: "db.ssl_enforcement" },
  { prefix: ["api"], resource: "api" },
  { prefix: ["auth"], resource: "auth" },
  { prefix: ["storage"], resource: "storage" },
];

function isPrefixOf(prefix: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

/** Cost-matrix / confirmation-prompt key per resource — the three `db.*` resources share one prompt. */
export function legacyPushPromptKey(resource: LegacyPushResource): string {
  switch (resource) {
    case "api":
      return "api";
    case "db.settings":
    case "db.network_restrictions":
    case "db.ssl_enforcement":
      return "db";
    case "auth":
      return "auth";
    case "storage":
      return "storage";
  }
}

/**
 * Longest-prefix lookup: resolves a comparable config path to the resource
 * whose v1 endpoint can express it, `"unsupported"` when the path is
 * declared-comparable but has no v1 field, or `undefined` for a path outside
 * both tables (never expected for a path drawn from `changeSet.changes` — see
 * this module's unit test's drift guard).
 */
export function legacyPushResourceForPath(
  path: ReadonlyArray<string>,
): LegacyPushResource | "unsupported" | undefined {
  for (const unsupportedPrefix of LEGACY_PUSH_UNSUPPORTED_PREFIXES) {
    if (isPrefixOf(unsupportedPrefix, path)) {
      return "unsupported";
    }
  }
  let best: { readonly prefix: ReadonlyArray<string>; readonly resource: LegacyPushResource } | undefined;
  for (const entry of LEGACY_PUSH_RESOURCE_PREFIXES) {
    if (
      isPrefixOf(entry.prefix, path) &&
      (best === undefined || entry.prefix.length > best.prefix.length)
    ) {
      best = entry;
    }
  }
  return best?.resource;
}

export interface LegacyPushPlan {
  /** Pushable (`update` | `local_only`) changes per resource, path-ordered. */
  readonly changesByResource: ReadonlyMap<LegacyPushResource, ReadonlyArray<ConfigChange>>;
  /** Pushable-class changes whose path has no v1 write path. */
  readonly unsupported: ReadonlyArray<ReadonlyArray<string>>;
  /** Count of `remote_only` changes (hands-off; informational only). */
  readonly remoteOnly: number;
}

/**
 * Groups a config diff's pushable changes by the resource that will write
 * them. `remote_only` changes are hands-off (never pushed) and are only
 * counted; a pushable change with no v1 write path is collected into
 * `unsupported` instead of a resource bucket.
 */
export function legacyPlanConfigPush(changeSet: ConfigChangeSet): LegacyPushPlan {
  const changesByResource = new Map<LegacyPushResource, Array<ConfigChange>>(
    LEGACY_PUSH_RESOURCES.map((resource) => [resource, []]),
  );
  const unsupported: Array<ReadonlyArray<string>> = [];

  for (const change of changeSet.changes) {
    if (change.class !== "update" && change.class !== "local_only") {
      continue;
    }
    const resource = legacyPushResourceForPath(change.path);
    if (resource === "unsupported") {
      unsupported.push(change.path);
      continue;
    }
    if (resource === undefined) {
      continue;
    }
    changesByResource.get(resource)?.push(change);
  }

  return {
    changesByResource,
    unsupported,
    remoteOnly: changeSet.counts.remote_only,
  };
}
