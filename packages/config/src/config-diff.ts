import {
  fromConfigDocument,
  isComparableProjectConfigPath,
  type ProjectConfig,
} from "./project-config/project-config.ts";
import { projectConfigMappingRows } from "./project-config/registry.ts";
import { getDefaultCliConfig } from "./sparse.ts";

/**
 * Config drift classification between the local project config and the
 * effective remote configuration reported by the Management API
 * (`GET /v2/projects/{ref}/config`). Pure and synchronous: fetching the
 * response, resolving the target, and rendering output are the caller's job
 * (`supabase config diff`, and `config pull` after it). See ADR 0022.
 *
 * Both operands are `ProjectConfig` values from CLI-2230's convergence
 * normalizers (ADR 0021): the caller builds `local` with
 * `fromConfigDocument({config, document})` (raw-presence-masked,
 * canonicalized, secrets omitted) and `remote` with
 * `fromApiProjectConfig(response)`. The comparable surface is the mapping
 * registry's — a path with no registry row is unmanaged by construction —
 * and the raw document's declared-key set drives `update` vs `remote_only`,
 * since a decoded config cannot distinguish "the file wrote the default"
 * from "the file is silent".
 */

export type ConfigChangeClass = "update" | "remote_only" | "local_only";

export interface ConfigChange {
  /** Dotted config path within the hosted subset, e.g. `"api.max_rows"`. */
  readonly path: string;
  /**
   * `update`: declared locally and reported remotely, values differ.
   * `remote_only`: reported remotely while the file does not declare it (or
   * push cannot communicate the declared state), and differing from the
   * default config's own convergence projection. `local_only`: the local
   * projection carries a declared value the response did not account for.
   */
  readonly class: ConfigChangeClass;
  /** Local convergence-projected value; `undefined` when absent. */
  readonly local: unknown;
  /** Remote value; `undefined` when the response did not report it. */
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
   * Managed secret paths the file sets a value for (the registry's
   * `isSecret` rows). These were never compared — the platform reports HMAC
   * digests, and both normalizers omit secret leaves — so a clean `changes`
   * list is still only a partial claim; callers must surface this.
   */
  readonly masked: ReadonlyArray<string>;
  readonly counts: ConfigChangeCounts;
}

export interface DiffProjectConfigOptions {
  /**
   * The local operand: `fromConfigDocument({config, document})`'s prediction
   * of the post-push hosted state (pass the loaded config WITH its raw
   * document so raw-presence masking applies — ADR 0021's remedy).
   */
  readonly local: ProjectConfig;
  /** The remote operand: `fromApiProjectConfig(response)`. */
  readonly remote: ProjectConfig;
  /**
   * The raw (pre-decode, post-merge) document the config was loaded from.
   * Declares which paths the file actually sets — the decoded config cannot,
   * because decoding materializes every default. `undefined` (a file that
   * did not parse to an object) means nothing is declared.
   */
  readonly declared: Readonly<Record<string, unknown>> | undefined;
  /**
   * Baseline for `remote_only` suppression: a remote value equal to this
   * projection's value at the same path is not drift. Defaults to the
   * default config's own convergence projection.
   */
  readonly defaults?: ProjectConfig;
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

/** Collects dotted leaf paths (arrays are leaves; records recurse). */
function collectLeafPaths(root: ProjectConfig): Array<string> {
  const leaves: Array<string> = [];
  const walk = (value: unknown, prefix: ReadonlyArray<string>): void => {
    if (isPlainRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        walk(child, [...prefix, key]);
      }
      return;
    }
    if (prefix.length > 0) {
      leaves.push(prefix.join("."));
    }
  };
  walk(root, []);
  return leaves;
}

function scalarEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  // Type-aware comparison: both operands are already canonicalized by the
  // convergence normalizers, but representation skew across schema versions
  // ("8080" vs 8080, "true" vs true) is still not drift.
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

/** Deduped dotted config paths of the registry's secret (`isSecret`) rows. */
const secretConfigPaths: ReadonlyArray<string> = [
  ...new Set(
    projectConfigMappingRows
      .filter((row) => row.isSecret === true)
      .map((row) => row.configPath.join(".")),
  ),
];

// The default config's own convergence projection — the `remote_only`
// suppression baseline. Lazy so importing this module never pays for a full
// schema decode + projection up front.
let defaultProjectionMemo: ProjectConfig | undefined;
function defaultProjection(): ProjectConfig {
  defaultProjectionMemo ??= fromConfigDocument(getDefaultCliConfig());
  return defaultProjectionMemo;
}

/**
 * Classifies every comparable path into the change set. Pure: no I/O, no
 * dependency on command flags or output formatting.
 */
export function diffProjectConfig(options: DiffProjectConfigOptions): ConfigChangeSet {
  const defaults = options.defaults ?? defaultProjection();
  const declaredRoot = options.declared ?? {};
  const changes: Array<ConfigChange> = [];

  const paths = new Set([...collectLeafPaths(options.local), ...collectLeafPaths(options.remote)]);
  for (const path of paths) {
    if (!isComparableProjectConfigPath(path.split("."))) {
      continue;
    }
    const localValue = valueAtPath(options.local, path);
    const remoteValue = valueAtPath(options.remote, path);
    const declared = isDeclaredAtPath(declaredRoot, path);
    const envVariable = options.envReferences?.get(path);

    if (localValue !== undefined && remoteValue !== undefined) {
      if (isEqualConfigValue(localValue, remoteValue)) {
        continue;
      }
      // A declared value differing from the remote is an update; an
      // undeclared one is remote-side drift against the (materialized)
      // default the local projection carries.
      changes.push(
        declared
          ? {
              path,
              class: "update",
              local: localValue,
              remote: remoteValue,
              ...(envVariable === undefined ? {} : { envVariable }),
            }
          : { path, class: "remote_only", local: undefined, remote: remoteValue },
      );
      continue;
    }

    if (remoteValue !== undefined) {
      // The local projection is silent: the file doesn't declare it, or push
      // cannot communicate the declared state (ADR 0021's unmanaged-by-push
      // families). Suppress the remote value when it matches the default
      // config's own projection; for paths that projection is also silent on
      // (push-gated containers), fall back to the raw default config's value
      // (e.g. `db.network_restrictions.allowed_cidrs`'s allow-all default is
      // exactly the platform's unconfigured state), then to the type's zero
      // value (the platform's report of an unconfigured feature).
      const baseline = valueAtPath(defaults, path) ?? valueAtPath(getDefaultCliConfig(), path);
      const suppressed =
        baseline === undefined
          ? isZeroValue(remoteValue)
          : isEqualConfigValue(baseline, remoteValue);
      if (!suppressed) {
        changes.push({ path, class: "remote_only", local: undefined, remote: remoteValue });
      }
      continue;
    }

    if (declared) {
      changes.push({
        path,
        class: "local_only",
        local: localValue,
        remote: undefined,
        ...(envVariable === undefined ? {} : { envVariable }),
      });
    }
  }

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const masked = secretConfigPaths.filter((path) => isDeclaredAtPath(declaredRoot, path)).sort();

  return {
    changes,
    masked,
    counts: {
      update: changes.filter((change) => change.class === "update").length,
      remote_only: changes.filter((change) => change.class === "remote_only").length,
      local_only: changes.filter((change) => change.class === "local_only").length,
    },
  };
}
