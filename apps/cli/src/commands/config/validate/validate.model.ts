import { ENV_CAPTURE_REGEX, isSecretPath, type CliConfigLocation } from "@supabase/config/internal";

import { cliConfigRegistry } from "../../../config/cli-config-keys.ts";

type ProblemCode =
  | "syntax"
  | "file_conflict"
  | "schema_version"
  | "removed_key"
  | "unknown_key"
  | "invalid_type"
  | "invalid_enum"
  | "invalid_value"
  | "missing_required"
  | "remote_project_id"
  | "env_file"
  | "removed_env"
  | "env_unresolved"
  | "deprecated_key"
  | "shadowed_file"
  | "unrecognized_schema";

export interface ConfigProblem {
  readonly code: ProblemCode;
  readonly severity: "error" | "warning";
  /** The key's path with any `remotes.<name>.` prefix removed. */
  readonly path?: string;
  readonly remote?: string;
  /** Names the file a pathless problem is about when it is not the validated one. */
  readonly subject?: string;
  /** What is wrong, short and free of configured values. */
  readonly reason: string;
  readonly help?: string;
  readonly location?: CliConfigLocation;
  /** The value comes from the environment, so the config file has no location for it. */
  readonly external?: true;
  /** The source line may print the value at `location`; every other line is masked. */
  readonly showValue: boolean;
}

/** Splits a `remotes.<name>.…` path into the remote and the path inside it. */
export function splitRemotePath(path: ReadonlyArray<string>): {
  readonly remote?: string;
  readonly path: ReadonlyArray<string>;
} {
  const [head, name] = path;
  return head === "remotes" && name !== undefined
    ? { remote: name, path: path.slice(2) }
    : { path };
}

const ROOT_KEY_PATH = "db.root_key";
const SECRET_LOOKING = /secret|pass|token|key|jwt|salt|credential|vault/i;

const publicLeafPaths: ReadonlySet<string> = new Set(
  cliConfigRegistry.keys
    .filter((key) => key.document !== false && key.secret !== true)
    .map((key) => key.path),
);

const publicFamilyLeaves = cliConfigRegistry.families.map((family) => ({
  prefix: family.prefix.split("."),
  fields: new Set(
    family.fields.filter((field) => field.secret !== true).map((field) => field.name),
  ),
}));

const isPublicFamilyLeaf = (segments: ReadonlyArray<string>): boolean =>
  publicFamilyLeaves.some(
    ({ prefix, fields }) =>
      segments.length === prefix.length + 2 &&
      prefix.every((segment, index) => segment === segments[index]) &&
      fields.has(segments.at(-1) ?? ""),
  );

/**
 * Whether the value at a config key path may be printed: a schema leaf that is neither secret nor
 * secret-looking. Everything else, including keys the schema does not know, is masked.
 */
export function isPublicValuePath(path: string): boolean {
  const segments = splitRemotePath(path.split(".")).path;
  const local = segments.join(".");
  return (
    local !== ROOT_KEY_PATH &&
    !isSecretPath(segments) &&
    !SECRET_LOOKING.test(segments.at(-1) ?? "") &&
    (publicLeafPaths.has(local) || isPublicFamilyLeaf(segments))
  );
}

const keyOf = (problem: ConfigProblem): string =>
  `${problem.code}\0${problem.remote ?? ""}\0${problem.path ?? ""}\0${problem.subject ?? ""}`;

const KEYED_BY_PATH: ReadonlySet<ProblemCode> = new Set([
  "invalid_type",
  "invalid_enum",
  "invalid_value",
  "missing_required",
]);

/**
 * Removes what the remote passes repeat from the base pass, and keeps one problem per key for the
 * value-level codes, so a key a later pass reports again appears once. A remote problem on a key
 * the remote block writes itself is that remote's own, even when the base reports the same one.
 */
export function dedupeProblems(
  problems: ReadonlyArray<ConfigProblem>,
  remoteWrites: (remote: string, path: string) => boolean,
): ReadonlyArray<ConfigProblem> {
  const base = new Set(
    problems
      .filter((problem) => problem.remote === undefined)
      .map((problem) => `${keyOf(problem)}\0${problem.reason}`),
  );
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const full = `${keyOf(problem)}\0${problem.reason}`;
    const inherited =
      problem.remote !== undefined &&
      base.has(`${keyOf({ ...problem, remote: undefined })}\0${problem.reason}`) &&
      !remoteWrites(problem.remote, problem.path ?? "");
    if (inherited) return false;
    const identity = KEYED_BY_PATH.has(problem.code) ? keyOf(problem) : full;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

const atOrBelow = (path: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean =>
  prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);

/** Drops problems at or below a key the load pruned or left out, which only exist because of that removal. */
export function withoutFollowOns(
  problems: ReadonlyArray<ConfigProblem>,
  removed: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ConfigProblem> {
  return problems.filter(
    (problem) =>
      problem.path === undefined ||
      !removed.some((prefix) => atOrBelow(problem.path?.split(".") ?? [], prefix)),
  );
}

export interface EnvReference {
  readonly name: string;
  readonly remote?: string;
  readonly path: ReadonlyArray<string>;
}

/** Every whole-value `env(NAME)` string in a raw document, with the key path that holds it. */
export function envReferences(document: unknown): ReadonlyArray<EnvReference> {
  const found: Array<EnvReference> = [];
  const walk = (value: unknown, path: ReadonlyArray<string>): void => {
    if (typeof value === "string") {
      const name = ENV_CAPTURE_REGEX.exec(value)?.[1];
      if (name === undefined) return;
      const split = splitRemotePath(path);
      found.push({
        name,
        path: split.path,
        ...(split.remote === undefined ? {} : { remote: split.remote }),
      });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, String(index)]));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
    }
  };
  walk(document, []);
  return found;
}

/**
 * Drops errors that sit at or below a key whose `env(NAME)` reference could not be resolved in the
 * same pass, and names the references that caused a drop.
 */
export function withoutUnresolvedEnvErrors(
  problems: ReadonlyArray<ConfigProblem>,
  unresolved: ReadonlyArray<EnvReference>,
): { readonly kept: ReadonlyArray<ConfigProblem>; readonly blamed: ReadonlyArray<EnvReference> } {
  const blamed = new Set<EnvReference>();
  const kept = problems.filter((problem) => {
    if (problem.severity !== "error" || problem.path === undefined) return true;
    const segments = problem.path.split(".");
    const owners = unresolved.filter(
      (reference) => reference.remote === problem.remote && atOrBelow(segments, reference.path),
    );
    for (const owner of owners) blamed.add(owner);
    return owners.length === 0;
  });
  return { kept, blamed: [...blamed] };
}

const readPath = (root: unknown, path: ReadonlyArray<string>): unknown => {
  let node = root;
  for (const segment of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = Reflect.get(node, segment);
  }
  return node;
};

/**
 * The value of the nearest enclosing table's `enabled` switch on an owning pass's resolved
 * config, or `undefined` when no enclosing table has one.
 */
export function nearestEnabledGate(
  config: unknown,
  path: ReadonlyArray<string>,
): boolean | undefined {
  for (let depth = path.length - 1; depth > 0; depth--) {
    const enabled = readPath(config, [...path.slice(0, depth), "enabled"]);
    if (typeof enabled === "boolean") return enabled;
  }
  return undefined;
}
