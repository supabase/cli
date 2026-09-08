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

import { isPrefixOf, pathIn, samePath, valueAtPath } from "./push.paths.ts";

export type PushResource =
  | "api"
  | "db.settings"
  | "db.network_restrictions"
  | "db.ssl_enforcement"
  | "auth"
  | "storage";

/** Push order — the order `config push` has always processed its services in. */
export const PUSH_RESOURCES: ReadonlyArray<PushResource> = [
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
 * `db.pooler.{pool_mode,default_pool_size,max_client_conn}`.
 */
export const PUSH_UNSUPPORTED_PREFIXES: ReadonlyArray<ReadonlyArray<string>> = [
  ["db", "major_version"],
  ["db", "pooler"],
];

/** Longest-registered-prefix routing target for a comparable config path. */
const PUSH_RESOURCE_PREFIXES: ReadonlyArray<{
  readonly prefix: ReadonlyArray<string>;
  readonly resource: PushResource;
}> = [
  { prefix: ["db", "settings"], resource: "db.settings" },
  { prefix: ["db", "network_restrictions"], resource: "db.network_restrictions" },
  { prefix: ["db", "ssl_enforcement"], resource: "db.ssl_enforcement" },
  { prefix: ["api"], resource: "api" },
  { prefix: ["auth"], resource: "auth" },
  { prefix: ["storage"], resource: "storage" },
];

/** Cost-matrix / confirmation-prompt key per resource — the three `db.*` resources share one prompt. */
export function pushPromptKey(resource: PushResource): string {
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
export function pushResponseBlock(resource: PushResource): "api" | "database" | "auth" | "storage" {
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
export function pushResourceForPath(path: ReadonlyArray<string>): PushResource | "unsupported" {
  for (const unsupportedPrefix of PUSH_UNSUPPORTED_PREFIXES) {
    if (isPrefixOf(unsupportedPrefix, path)) {
      return "unsupported";
    }
  }
  let best: { readonly prefix: ReadonlyArray<string>; readonly resource: PushResource } | undefined;
  for (const entry of PUSH_RESOURCE_PREFIXES) {
    if (
      isPrefixOf(entry.prefix, path) &&
      (best === undefined || entry.prefix.length > best.prefix.length)
    ) {
      best = entry;
    }
  }
  return best?.resource ?? "unsupported";
}

export interface PushPlan {
  /** Pushable (`update` | `local_only`) changes per resource, path-ordered. Total — every resource has an entry, even an empty one. */
  readonly changesByResource: Readonly<Record<PushResource, ReadonlyArray<ConfigChange>>>;
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
export function planConfigPush(changeSet: ConfigChangeSet): PushPlan {
  const changesByResource: Record<PushResource, Array<ConfigChange>> = {
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
    const resource = pushResourceForPath(change.path);
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
 * (`db.network_restrictions`'s own `enabled` flag) and the local projection
 * (`db.ssl_enforcement`'s declared presence — undeclared means the
 * raw-presence mask already dropped the whole subtree). `api`, `db.settings`,
 * `auth`, and `storage` have no such gate: `api`/`db.settings` never had one,
 * and `auth.enabled`/`storage.enabled` no longer gate their resource either
 * (CLI-2314, correcting a prior mistake) — that flag controls only the local
 * GoTrue/Storage Docker service, with no Management API equivalent, so
 * gating the whole resource on it silently dropped a user's declared
 * hosted-auth/storage changes whenever they simply didn't run that service
 * locally. `db.network_restrictions.enabled` stays a genuine gate: it is a
 * real hosted-side management opt-out, not a local-service toggle.
 */
export function pushResourceEnabled(
  resource: PushResource,
  config: CliConfig,
  local: ProjectConfig,
): boolean {
  switch (resource) {
    case "api":
    case "db.settings":
    case "auth":
    case "storage":
      return true;
    case "db.network_restrictions":
      return config.db.network_restrictions.enabled;
    case "db.ssl_enforcement":
      return local.db?.ssl_enforcement !== undefined;
  }
}

export interface PushAddonGate {
  readonly costKey: "auth_mfa_phone" | "auth_mfa_web_authn";
  readonly verifyPath: ReadonlyArray<string>;
  readonly enrollPath: ReadonlyArray<string>;
}

/** The two paid MFA addons whose enablement is gated behind a cost-aware prompt. */
export const PUSH_ADDON_GATES: ReadonlyArray<PushAddonGate> = [
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
export function pushAddonPromptNeeded(
  changes: ReadonlyArray<ConfigChange>,
  gate: PushAddonGate,
  remote: ProjectConfig,
): boolean {
  if (valueAtPath(remote, gate.verifyPath) === true) {
    return false;
  }
  const turnsOn = (path: ReadonlyArray<string>): boolean =>
    changes.some((change) => samePath(change.path, path) && change.local === true);
  return turnsOn(gate.verifyPath) || turnsOn(gate.enrollPath);
}

/** The routed change list, narrowed to the paths a resource's body actually communicated. */
export function changesCommunicated(
  changes: ReadonlyArray<ConfigChange>,
  encodedPaths: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ConfigChange> {
  return changes.filter((change) => pathIn(change.path, encodedPaths));
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
export function applyMfaAddonDecline(
  changes: ReadonlyArray<ConfigChange>,
  gate: PushAddonGate,
  remote: ProjectConfig,
): ReadonlyArray<ConfigChange> {
  const withoutGate = changes.filter(
    (change) => !samePath(change.path, gate.verifyPath) && !samePath(change.path, gate.enrollPath),
  );
  const remoteVerify = valueAtPath(remote, gate.verifyPath);
  const remoteEnroll = valueAtPath(remote, gate.enrollPath);
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
