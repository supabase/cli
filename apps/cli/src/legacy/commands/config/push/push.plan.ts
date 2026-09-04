/**
 * Pushable-path registry and per-resource grouping for `config push`.
 *
 * `diffProjectConfig`'s `changeSet.changes` can only contain paths the
 * `@supabase/config` mapping registry knows about (non-secret rows). This
 * module routes each such path to the v1 write endpoint that can express it
 * (a "resource"), or classifies it as declared-but-unwritable ("unsupported")
 * when no v1 field exists for it at all.
 */

import type { CliConfig, ConfigChange, ConfigChangeSet, ProjectConfig } from "@supabase/config";

import { legacyIsPrefixOf, legacyPathIn, legacySamePath, legacyValueAtPath } from "./push.paths.ts";

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

/** The Management API v2 response block a resource's comparisons are read from. */
export function legacyPushResponseBlock(
  resource: LegacyPushResource,
): "api" | "database" | "auth" | "storage" {
  switch (resource) {
    case "api":
      return "api";
    case "db.settings":
    case "db.network_restrictions":
    case "db.ssl_enforcement":
      return "database";
    case "auth":
      return "auth";
    case "storage":
      return "storage";
  }
}

/**
 * Longest-prefix lookup: resolves a comparable config path to the resource
 * whose v1 endpoint can express it, or `"unsupported"` — both for a path
 * declared-comparable but with no v1 field, and for a path outside every
 * registered prefix (never expected for a path drawn from
 * `changeSet.changes` — see this module's unit test's drift guard). Never
 * `undefined`, so a resource lookup is total for every caller.
 */
export function legacyPushResourceForPath(
  path: ReadonlyArray<string>,
): LegacyPushResource | "unsupported" {
  for (const unsupportedPrefix of LEGACY_PUSH_UNSUPPORTED_PREFIXES) {
    if (legacyIsPrefixOf(unsupportedPrefix, path)) {
      return "unsupported";
    }
  }
  let best:
    | { readonly prefix: ReadonlyArray<string>; readonly resource: LegacyPushResource }
    | undefined;
  for (const entry of LEGACY_PUSH_RESOURCE_PREFIXES) {
    if (
      legacyIsPrefixOf(entry.prefix, path) &&
      (best === undefined || entry.prefix.length > best.prefix.length)
    ) {
      best = entry;
    }
  }
  return best?.resource ?? "unsupported";
}

export interface LegacyPushPlan {
  /** Pushable (`update` | `local_only`) changes per resource, path-ordered. Total — every resource has an entry, even an empty one. */
  readonly changesByResource: Readonly<Record<LegacyPushResource, ReadonlyArray<ConfigChange>>>;
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
  const changesByResource: Record<LegacyPushResource, Array<ConfigChange>> = {
    api: [],
    "db.settings": [],
    "db.network_restrictions": [],
    "db.ssl_enforcement": [],
    auth: [],
    storage: [],
  };
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
    changesByResource[resource].push(change);
  }

  return {
    changesByResource,
    unsupported,
    remoteOnly: changeSet.counts.remote_only,
  };
}

/**
 * Whether a resource is even eligible to be pushed, given the decoded config
 * (`db.network_restrictions`/`auth`/`storage`'s own `enabled` flag) and the
 * local projection (`db.ssl_enforcement`'s declared presence — undeclared
 * means the raw-presence mask already dropped the whole subtree). `api` and
 * `db.settings` have no such gate.
 */
export function legacyPushResourceEnabled(
  resource: LegacyPushResource,
  config: CliConfig,
  local: ProjectConfig,
): boolean {
  switch (resource) {
    case "api":
    case "db.settings":
      return true;
    case "db.network_restrictions":
      return config.db.network_restrictions.enabled;
    case "db.ssl_enforcement":
      return local.db?.ssl_enforcement !== undefined;
    case "auth":
      return config.auth.enabled;
    case "storage":
      return config.storage.enabled;
  }
}

export interface LegacyPushAddonGate {
  readonly costKey: "auth_mfa_phone" | "auth_mfa_web_authn";
  readonly verifyPath: ReadonlyArray<string>;
  readonly enrollPath: ReadonlyArray<string>;
}

/** The two paid MFA addons whose enablement is gated behind a cost-aware prompt. */
export const LEGACY_PUSH_ADDON_GATES: ReadonlyArray<LegacyPushAddonGate> = [
  {
    costKey: "auth_mfa_phone",
    verifyPath: ["auth", "mfa", "phone", "verify_enabled"],
    enrollPath: ["auth", "mfa", "phone", "enroll_enabled"],
  },
  {
    costKey: "auth_mfa_web_authn",
    verifyPath: ["auth", "mfa", "web_authn", "verify_enabled"],
    enrollPath: ["auth", "mfa", "web_authn", "enroll_enabled"],
  },
];

/**
 * Whether an addon gate's cost-aware prompt should fire for this push: the
 * routed change list turns on `verify_enabled` OR `enroll_enabled` (either
 * flip is a new paid capability on its own — enrolment alone already starts
 * SMS/WebAuthn charges), UNLESS the addon is already active on the project
 * (`remote`'s `verify_enabled` is `true`), in which case there is no new
 * cost to confirm.
 */
export function legacyPushAddonPromptNeeded(
  changes: ReadonlyArray<ConfigChange>,
  gate: LegacyPushAddonGate,
  remote: ProjectConfig,
): boolean {
  if (legacyValueAtPath(remote, gate.verifyPath) === true) {
    return false;
  }
  const turnsOn = (path: ReadonlyArray<string>): boolean =>
    changes.some((change) => legacySamePath(change.path, path) && change.local === true);
  return turnsOn(gate.verifyPath) || turnsOn(gate.enrollPath);
}

/** The routed change list, narrowed to the paths a resource's body actually communicated. */
export function legacyChangesCommunicated(
  changes: ReadonlyArray<ConfigChange>,
  encodedPaths: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ConfigChange> {
  return changes.filter((change) => legacyPathIn(change.path, encodedPaths));
}

/**
 * Applies a declined paid-MFA-addon prompt to the routed auth change list.
 * Drops the addon's `verify_enabled`/`enroll_enabled` changes; when the
 * remote currently has either flag `true`, replaces them with synthetic
 * `update` changes setting both to `false` instead — so the request body
 * carries an explicit disable, leaving the project in the same state the
 * user would get by disabling the addon directly. When the remote already
 * has both flags `false` (or unset), the changes are simply dropped:
 * omitting them leaves the remote's current (already disabled) state
 * untouched.
 */
export function legacyApplyMfaAddonDecline(
  changes: ReadonlyArray<ConfigChange>,
  gate: LegacyPushAddonGate,
  remote: ProjectConfig,
): ReadonlyArray<ConfigChange> {
  const withoutGate = changes.filter(
    (change) =>
      !legacySamePath(change.path, gate.verifyPath) &&
      !legacySamePath(change.path, gate.enrollPath),
  );
  const remoteVerify = legacyValueAtPath(remote, gate.verifyPath);
  const remoteEnroll = legacyValueAtPath(remote, gate.enrollPath);
  if (remoteVerify !== true && remoteEnroll !== true) {
    return withoutGate;
  }
  const disableChange = (path: ReadonlyArray<string>, remoteValue: unknown): ConfigChange => ({
    path,
    class: "update",
    local: false,
    remote: remoteValue,
    declared: true,
  });
  return [
    ...withoutGate,
    disableChange(gate.verifyPath, remoteVerify),
    disableChange(gate.enrollPath, remoteEnroll),
  ];
}
