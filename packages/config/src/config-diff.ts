import type { CliConfigValueOrigin } from "./config-document.ts";
import {
  type CliConfigWithRawPresence,
  comparableProjectConfigPaths,
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
 * Both operands are convergence projections from CLI-2230's normalizers (ADR
 * 0021): the local operand is derived here from the loaded `{config,
 * document}` pair via `fromConfigDocument` (raw-presence-masked,
 * canonicalized, secrets omitted), and the caller builds `remote` with
 * `fromApiProjectConfig(response)`. The comparable surface is the mapping
 * registry's — a path with no registry row is unmanaged by construction —
 * and the raw document's declared-key set drives `update` vs `remote_only`,
 * since a decoded config cannot distinguish "the file wrote the default"
 * from "the file is silent".
 *
 * Paths are segment arrays everywhere in this module's API (a record key —
 * an `auth.sms.test_otp` phone number, a `[remotes.*]` name — may itself
 * contain a `.`, so dotted strings are lossy); joining is display-only and
 * belongs to the renderer.
 */

export type ConfigChangeClass = "update" | "remote_only" | "local_only";

export interface ConfigChange {
  /**
   * Config path segments within the hosted subset, e.g. `["api",
   * "max_rows"]`. Join for display only — a segment may contain a `.`.
   */
  readonly path: ReadonlyArray<string>;
  /**
   * `update`: declared locally and reported remotely, values differ.
   * `remote_only`: reported remotely while the file does not declare it (or
   * push cannot communicate the declared state), and differing from the
   * unconfigured baseline. `local_only`: the local projection carries a
   * declared value the response did not account for.
   */
  readonly class: ConfigChangeClass;
  /**
   * Local convergence-projected value; `undefined` when the projection is
   * silent. For an undeclared `remote_only` path this is the materialized
   * schema default — the value a `config push` would write over the remote —
   * so consumers can answer "what would push change?" without re-deriving it.
   */
  readonly local: unknown;
  /** Remote value; `undefined` when the response did not report it. */
  readonly remote: unknown;
  /**
   * Whether the raw document declares this path — distinguishes "the file
   * wrote this value" from "the local side is a schema-materialized default".
   */
  readonly declared: boolean;
  /** Environment variables local `env()` references resolved from, if any. */
  readonly envVariables?: ReadonlyArray<string> | undefined;
}

export interface ConfigChangeCounts {
  readonly update: number;
  readonly remote_only: number;
  readonly local_only: number;
  readonly total: number;
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
  readonly masked: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * Comparable non-secret paths the file declares but the local projection
   * dropped — declared state a `config push` structurally cannot communicate
   * (ADR 0021's unmanaged-by-push families: `auth.oauth_server`, disabled
   * `storage.analytics`/`storage.vector`, siblings of a disabled container's
   * sentinel, an unselected SMS provider's credentials, …). These were never
   * compared on the local side, so — like `masked` — a clean `changes` list
   * is only a partial claim; callers must surface this rather than let a
   * declared value silently vanish from the comparison.
   */
  readonly unmanaged: ReadonlyArray<ReadonlyArray<string>>;
  readonly counts: ConfigChangeCounts;
}

export interface DiffProjectConfigOptions {
  /**
   * The loaded local config: the `{config, document}` pair
   * `fromConfigDocument` accepts (pass the loaded config WITH its raw
   * document so raw-presence masking applies — ADR 0021's remedy), plus the
   * loader's `valueOrigins` when env-var attribution is wanted. The local
   * projection and the declared-key set are both derived from this one value,
   * so they can never come from different loads. `LoadedCliConfig` is
   * structurally assignable. Note `fromConfigDocument` runs inside
   * `diffProjectConfig`, so a document the registry cannot canonicalize
   * throws `ProjectConfigParseError` from here.
   */
  readonly local: CliConfigWithRawPresence & {
    readonly valueOrigins?: ReadonlyArray<CliConfigValueOrigin> | undefined;
  };
  /** The remote operand: `fromApiProjectConfig(response)`. */
  readonly remote: ProjectConfig;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathKey(path: ReadonlyArray<string>): string {
  return JSON.stringify(path);
}

/** Walks a segment path through records with own-key checks only. */
function valueAtPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isDeclaredAtPath(
  root: Readonly<Record<string, unknown>>,
  path: ReadonlyArray<string>,
): boolean {
  let current: unknown = root;
  for (const [index, segment] of path.entries()) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      return false;
    }
    if (index < path.length - 1) {
      current = current[segment];
    }
  }
  return true;
}

/** Collects leaf paths as segment arrays (arrays are leaves; records recurse). */
function collectLeafPaths(root: ProjectConfig): Array<ReadonlyArray<string>> {
  const leaves: Array<ReadonlyArray<string>> = [];
  const walk = (value: unknown, prefix: ReadonlyArray<string>): void => {
    if (isPlainRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        walk(child, [...prefix, key]);
      }
      return;
    }
    if (prefix.length > 0) {
      leaves.push(prefix);
    }
  };
  walk(root, []);
  return leaves;
}

/** Segment-wise path order — the display order of the change list. */
function comparePaths(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a[index] as string;
    const right = b[index] as string;
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return a.length - b.length;
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

export type ConfigArrayEquality = "set" | "sequence";

/**
 * Type-aware value equality. Scalars tolerate string/number and
 * string/boolean representation skew. Arrays default to SEQUENCE semantics —
 * element order is meaningful unless the field's registry row opts into
 * `"set"` (whether an array is a set or a sequence is per-field wire
 * knowledge: `api.schemas`' first entry is PostgREST's default schema and
 * `api.extra_search_path` is a literal `search_path`, while
 * `auth.additional_redirect_urls` is membership-only). Defaulting to
 * sequence over-reports rather than under-reports drift.
 */
export function isEqualConfigValue(
  a: unknown,
  b: unknown,
  arrayEquality: ConfigArrayEquality = "sequence",
): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (arrayEquality === "set") {
      // TRUE set semantics: membership only. Duplicates carry no meaning for
      // a set-mode field (a repeated redirect URL is the same allow list),
      // so they must not register as drift.
      const left = new Set(a.map(canonicalArrayElement));
      const right = new Set(b.map(canonicalArrayElement));
      return left.size === right.size && [...left].every((element) => right.has(element));
    }
    if (a.length !== b.length) {
      return false;
    }
    const left = a.map(canonicalArrayElement);
    const right = b.map(canonicalArrayElement);
    return left.every((element, index) => element === right[index]);
  }
  return scalarEqual(a, b);
}

/** Deduped secret (`isSecret`) row config paths, in registry order. */
const secretConfigPaths: ReadonlyArray<ReadonlyArray<string>> = (() => {
  const seen = new Set<string>();
  const paths: Array<ReadonlyArray<string>> = [];
  for (const row of projectConfigMappingRows) {
    if (row.isSecret !== true || seen.has(pathKey(row.configPath))) {
      continue;
    }
    seen.add(pathKey(row.configPath));
    paths.push(row.configPath);
  }
  return paths;
})();

// Per-path row knowledge the classifier consumes, first row wins — matching
// `comparableProjectConfigPaths`'s own dedupe order for paths several rows
// share.
const arrayEqualityByPathKey: ReadonlyMap<string, ConfigArrayEquality> = (() => {
  const map = new Map<string, ConfigArrayEquality>();
  for (const row of projectConfigMappingRows) {
    if (row.arrayEquality !== undefined && !map.has(pathKey(row.configPath))) {
      map.set(pathKey(row.configPath), row.arrayEquality);
    }
  }
  return map;
})();

const unconfiguredValueByPathKey: ReadonlyMap<string, unknown> = (() => {
  const map = new Map<string, unknown>();
  for (const row of projectConfigMappingRows) {
    if (Object.hasOwn(row, "unconfiguredValue") && !map.has(pathKey(row.configPath))) {
      map.set(pathKey(row.configPath), row.unconfiguredValue);
    }
  }
  return map;
})();

/**
 * Equality at a specific path: array semantics come from the path's registry
 * row (or the nearest mapped ancestor — a mapped container's descendant
 * leaves inherit its row), defaulting to sequence.
 */
function equalsAtPath(path: ReadonlyArray<string>, a: unknown, b: unknown): boolean {
  for (let length = path.length; length >= 1; length--) {
    const equality = arrayEqualityByPathKey.get(pathKey(path.slice(0, length)));
    if (equality !== undefined) {
      return isEqualConfigValue(a, b, equality);
    }
  }
  return isEqualConfigValue(a, b);
}

// The default config's own convergence projection — the first `remote_only`
// suppression baseline tier. Lazy so importing this module never pays for a
// full schema decode + projection up front.
let defaultProjectionMemo: ProjectConfig | undefined;
function defaultProjection(): ProjectConfig {
  defaultProjectionMemo ??= fromConfigDocument(getDefaultCliConfig());
  return defaultProjectionMemo;
}

/**
 * Classifies every comparable path into the change set. Pure: no I/O, no
 * dependency on command flags or output formatting. Runs `fromConfigDocument`
 * over `options.local`, so a document the registry cannot canonicalize throws
 * `ProjectConfigParseError` — callers translate at their own boundary.
 */
export function diffProjectConfig(options: DiffProjectConfigOptions): ConfigChangeSet {
  const local = fromConfigDocument(options.local);
  const declaredRoot = options.local.document ?? {};
  const envReferences = new Map<string, ReadonlyArray<string>>();
  for (const origin of options.local.valueOrigins ?? []) {
    if (origin.source === "environment" && origin.envVariables !== undefined) {
      envReferences.set(pathKey(origin.path), origin.envVariables);
    }
  }

  const changes: Array<ConfigChange> = [];
  const paths = new Map<string, ReadonlyArray<string>>();
  for (const path of [...collectLeafPaths(local), ...collectLeafPaths(options.remote)]) {
    paths.set(pathKey(path), path);
  }

  for (const path of paths.values()) {
    if (!isComparableProjectConfigPath(path)) {
      continue;
    }
    const localValue = valueAtPath(local, path);
    const remoteValue = valueAtPath(options.remote, path);
    const declared = isDeclaredAtPath(declaredRoot, path);
    const envVariables = envReferences.get(pathKey(path));

    if (localValue !== undefined && remoteValue !== undefined) {
      if (equalsAtPath(path, localValue, remoteValue)) {
        continue;
      }
      // A declared value differing from the remote is an update; an
      // undeclared one is remote-side drift against the (materialized)
      // default the local projection carries — which stays populated on the
      // change so consumers can see what a push would write.
      changes.push({
        path,
        class: declared ? "update" : "remote_only",
        local: localValue,
        remote: remoteValue,
        declared,
        ...(envVariables === undefined ? {} : { envVariables }),
      });
      continue;
    }

    if (remoteValue !== undefined) {
      // The local projection is silent: the file doesn't declare it, or push
      // cannot communicate the declared state (ADR 0021's unmanaged-by-push
      // families — those paths additionally surface in `unmanaged` below).
      // Suppress the remote value when it matches the unconfigured baseline:
      // the default config's own projection, then the raw default config
      // (push-gated containers, e.g. network restrictions' allow-all), then
      // the registry row's declared `unconfiguredValue` (the platform's
      // report of an unconfigured feature, e.g. `sessions_timebox: 0`
      // canonicalized to `"0s"`, or the provisioning-default mailer
      // subjects). With no baseline at any tier the value is reported —
      // "unconfigured" is never inferred from type-level zero values, since
      // canonicalization can turn a platform zero into a non-zero shape.
      const baseline =
        valueAtPath(defaultProjection(), path) ??
        valueAtPath(getDefaultCliConfig(), path) ??
        unconfiguredValueByPathKey.get(pathKey(path));
      const suppressed = baseline !== undefined && equalsAtPath(path, baseline, remoteValue);
      if (!suppressed) {
        changes.push({
          path,
          class: "remote_only",
          local: undefined,
          remote: remoteValue,
          declared,
          ...(envVariables === undefined ? {} : { envVariables }),
        });
      }
      continue;
    }

    if (declared) {
      changes.push({
        path,
        class: "local_only",
        local: localValue,
        remote: undefined,
        declared,
        ...(envVariables === undefined ? {} : { envVariables }),
      });
    }
  }

  changes.sort((a, b) => comparePaths(a.path, b.path));

  const masked = secretConfigPaths
    .filter((path) => isDeclaredAtPath(declaredRoot, path))
    .toSorted(comparePaths);

  // Declared comparable paths the local projection dropped: push cannot
  // communicate them, so they were never compared on the local side.
  // `comparableProjectConfigPaths` already excludes secret rows, so this
  // never overlaps `masked`.
  const unmanaged = comparableProjectConfigPaths
    .filter(
      (path) => isDeclaredAtPath(declaredRoot, path) && valueAtPath(local, path) === undefined,
    )
    .toSorted(comparePaths);

  const update = changes.filter((change) => change.class === "update").length;
  const remote_only = changes.filter((change) => change.class === "remote_only").length;
  const local_only = changes.filter((change) => change.class === "local_only").length;

  return {
    changes,
    masked,
    unmanaged,
    counts: { update, remote_only, local_only, total: update + remote_only + local_only },
  };
}
