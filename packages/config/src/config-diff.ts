import type { BaseProjectConfig } from "./sparse.ts";
import { getDefaultProjectConfig } from "./sparse.ts";
import { MANAGED_CONFIG_PROPERTIES } from "./config-diff.managed.ts";

/**
 * Config drift classification between a local project config and the
 * effective remote configuration reported by the Management API
 * (`GET /v2/projects/{ref}/config`). Pure and synchronous: fetching the
 * response, resolving the target, and rendering output are the caller's job
 * (`supabase config diff`, and `config pull` after it). See ADR 0019.
 */

/** The per-service blocks of the v2 project-config resource. */
export type RemoteConfigBlock = "api" | "auth" | "database" | "pooler" | "realtime" | "storage";

export const REMOTE_CONFIG_BLOCKS: ReadonlyArray<RemoteConfigBlock> = [
  "api",
  "auth",
  "database",
  "pooler",
  "realtime",
  "storage",
];

/**
 * Structural shape of the v2 response's `data.attributes`. Deliberately loose
 * (`Record<string, unknown>` per block): the wire format is owned by the
 * Management API and may grow keys at any time, and every read below descends
 * with runtime guards. This package must not import `@supabase/api` — the
 * caller passes whatever the generated client decoded.
 */
export interface RemoteProjectConfig {
  readonly api?: Readonly<Record<string, unknown>> | undefined;
  readonly auth?: Readonly<Record<string, unknown>> | undefined;
  readonly database?: Readonly<Record<string, unknown>> | undefined;
  readonly pooler?: Readonly<Record<string, unknown>> | undefined;
  readonly realtime?: Readonly<Record<string, unknown>> | undefined;
  readonly storage?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * One remotely-managed local schema property. The managed surface is *defined*
 * by the table of these entries (`config-diff.managed.ts`): a schema path with
 * no entry is unmanaged by construction and never appears in a change set.
 */
export interface ManagedConfigProperty {
  /** Dotted local schema path, e.g. `"api.max_rows"`. Always a leaf. */
  readonly path: string;
  /** Which v2 block reports this property. */
  readonly block: RemoteConfigBlock;
  /**
   * Secret-valued: the platform reports an HMAC (or omits the value), never
   * plaintext. The property is "present, unknown" — excluded from comparison
   * and surfaced via {@link ConfigChangeSet.masked} instead.
   */
  readonly secret?: boolean;
  /**
   * Reads this property's value from the response, coerced to the local
   * schema's type. `undefined` means the response did not carry it.
   */
  readonly read: (remote: RemoteProjectConfig) => unknown;
  /**
   * Canonicalizes a value before equality on both sides (e.g. byte-size
   * strings to byte counts). Reported values stay un-normalized.
   */
  readonly normalize?: (value: unknown) => unknown;
}

export type ConfigChangeClass = "update" | "remote_only" | "local_only";

export interface ConfigChange {
  /** Dotted local schema path. */
  readonly path: string;
  /**
   * `update`: declared locally and returned remotely, values differ.
   * `remote_only`: returned remotely, not declared in the file, and differing
   * from the schema default. `local_only`: declared in the file but the
   * response did not account for it.
   */
  readonly class: ConfigChangeClass;
  /** Effective local value; `undefined` when the file does not declare it. */
  readonly local: unknown;
  /** Remote value; `undefined` when the response did not return it. */
  readonly remote: unknown;
  /** Environment variable a local `env()` reference resolved from, if any. */
  readonly envVariable?: string | undefined;
}

export interface ConfigChangeCounts {
  readonly update: number;
  readonly remote_only: number;
  readonly local_only: number;
}

export interface ConfigChangeSet {
  /** Reportable differences, ordered by path. */
  readonly changes: ReadonlyArray<ConfigChange>;
  /**
   * Managed secret paths the file sets a value for. These were never compared
   * (the platform masks them), so a clean `changes` list is still only a
   * partial claim — callers must surface this.
   */
  readonly masked: ReadonlyArray<string>;
  /** Blocks the response actually carried, ordered per {@link REMOTE_CONFIG_BLOCKS}. */
  readonly scope: ReadonlyArray<RemoteConfigBlock>;
  readonly counts: ConfigChangeCounts;
}

export interface DiffProjectConfigOptions {
  /**
   * The *effective* local config: decoded with defaults filled, `env()`
   * resolved, and — when the target is a branch with a matching `[remotes.*]`
   * block — merged per ADR 0018.
   */
  readonly local: BaseProjectConfig;
  /**
   * The raw (pre-decode, post-merge) document the config was loaded from.
   * Declares which paths the file actually sets — the decoded config cannot,
   * because decoding materializes every default.
   */
  readonly declared: Readonly<Record<string, unknown>>;
  readonly remote: RemoteProjectConfig;
  /**
   * Baseline for `remote_only` suppression: a remote value equal to this
   * config's value at the same path is not drift. Defaults to the current
   * schema's default config.
   */
  readonly defaults?: BaseProjectConfig;
  /** Dotted local path → environment variable name, for `env()` reporting. */
  readonly envReferences?: ReadonlyMap<string, string>;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Walks a dotted path through records with own-key checks only. */
function valueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isDeclaredAtPath(root: Readonly<Record<string, unknown>>, path: string): boolean {
  let current: unknown = root;
  const segments = path.split(".");
  for (const [index, segment] of segments.entries()) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      return false;
    }
    if (index < segments.length - 1) {
      current = current[segment];
    }
  }
  return true;
}

function scalarEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  // Type-aware comparison: the response may carry "8080" where the schema
  // types the property as a number (or vice versa) — that is not drift.
  if (typeof a === "string" && typeof b === "number") {
    const parsed = Number(a.trim());
    return a.trim() !== "" && Number.isFinite(parsed) && parsed === b;
  }
  if (typeof a === "number" && typeof b === "string") {
    return scalarEqual(b, a);
  }
  if (typeof a === "string" && typeof b === "boolean") {
    return a.trim().toLowerCase() === String(b);
  }
  if (typeof a === "boolean" && typeof b === "string") {
    return scalarEqual(b, a);
  }
  return false;
}

function canonicalArrayElement(value: unknown): string {
  if (typeof value === "string") {
    return `s:${value}`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    // Scalars fold to their string form so "1" and 1 compare equal, matching
    // the scalar type-awareness above.
    return `s:${String(value)}`;
  }
  return `j:${JSON.stringify(value)}`;
}

function isZeroValue(value: unknown): boolean {
  return (
    value === false || value === "" || value === 0 || (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Order-insensitive, type-aware value equality: arrays compare as multisets
 * (`additional_redirect_urls` in a different order is not a difference), and
 * scalars tolerate string/number and string/boolean representation skew.
 */
export function isEqualConfigValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    const left = a.map(canonicalArrayElement).sort();
    const right = b.map(canonicalArrayElement).sort();
    return left.every((element, index) => element === right[index]);
  }
  return scalarEqual(a, b);
}

/**
 * Classifies every managed property into the change set. Pure: no I/O, no
 * dependency on command flags or output formatting.
 */
export function diffProjectConfig(options: DiffProjectConfigOptions): ConfigChangeSet {
  const defaults = options.defaults ?? getDefaultProjectConfig();
  const changes: Array<ConfigChange> = [];
  const masked: Array<string> = [];

  for (const property of MANAGED_CONFIG_PROPERTIES) {
    const declared = isDeclaredAtPath(options.declared, property.path);

    if (property.secret === true) {
      if (declared) {
        masked.push(property.path);
      }
      continue;
    }

    const remoteValue = property.read(options.remote);
    const localValue = valueAtPath(options.local, property.path);
    const normalize = property.normalize ?? ((value: unknown) => value);
    const envVariable = options.envReferences?.get(property.path);

    if (remoteValue !== undefined && declared) {
      if (!isEqualConfigValue(normalize(localValue), normalize(remoteValue))) {
        changes.push({
          path: property.path,
          class: "update",
          local: localValue,
          remote: remoteValue,
          ...(envVariable === undefined ? {} : { envVariable }),
        });
      }
      continue;
    }

    if (remoteValue !== undefined) {
      const defaultValue = valueAtPath(defaults, property.path);
      // Optional-key sections (db.ssl_enforcement, db.settings, auth
      // providers…) never materialize in the default config, so their paths
      // have no baseline value. The platform still reports the unconfigured
      // state for them as the type's zero value (false / "" / 0 / []) — an
      // undeclared feature reporting its zero value is not drift.
      const suppressed =
        defaultValue === undefined
          ? isZeroValue(remoteValue)
          : isEqualConfigValue(normalize(defaultValue), normalize(remoteValue));
      if (!suppressed) {
        changes.push({
          path: property.path,
          class: "remote_only",
          local: undefined,
          remote: remoteValue,
        });
      }
      continue;
    }

    if (declared) {
      changes.push({
        path: property.path,
        class: "local_only",
        local: localValue,
        remote: undefined,
        ...(envVariable === undefined ? {} : { envVariable }),
      });
    }
  }

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  masked.sort();

  return {
    changes,
    masked,
    scope: REMOTE_CONFIG_BLOCKS.filter((block) => isPlainRecord(options.remote[block])),
    counts: {
      update: changes.filter((change) => change.class === "update").length,
      remote_only: changes.filter((change) => change.class === "remote_only").length,
      local_only: changes.filter((change) => change.class === "local_only").length,
    },
  };
}
