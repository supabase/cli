import { ENV_CAPTURE_REGEX, type CliConfigLocation } from "@supabase/config/internal";

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
  /** The key's path segments with any `remotes.<name>.` prefix removed. */
  readonly path?: ReadonlyArray<string>;
  readonly remote?: string;
  /** Names the file a pathless problem is about when it is not the validated one. */
  readonly subject?: string;
  /** Names a pathless problem's subject in the text report when no file is associated with it. */
  readonly label?: string;
  /** What is wrong, short and free of configured values. */
  readonly reason: string;
  readonly help?: string;
  readonly location?: CliConfigLocation;
  /** The value comes from the environment, so the config file has no location for it. */
  readonly external?: true;
  /** Keys, besides `path`, whose values the check behind this problem read. */
  readonly reads?: ReadonlyArray<ReadonlyArray<string>>;
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

/** A key path as shown to people; segments that contain dots are indistinguishable from nesting. */
export const displayPath = (path: ReadonlyArray<string>): string => path.join(".");

const keyOf = (problem: ConfigProblem): string =>
  `${problem.code}\0${problem.remote ?? ""}\0${problem.path?.join("\0") ?? ""}\0${problem.subject ?? ""}`;

const VALUE_LEVEL_CODES: ReadonlySet<ProblemCode> = new Set([
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
  remoteWrites: (remote: string, path: ReadonlyArray<string>) => boolean,
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
      !remoteWrites(problem.remote, problem.path ?? []);
    if (inherited) return false;
    const identity = VALUE_LEVEL_CODES.has(problem.code) ? keyOf(problem) : full;
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
      !removed.some((prefix) => atOrBelow(problem.path ?? [], prefix)),
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
 * Drops value-level errors that sit at or below a key whose `env(NAME)` reference could not be
 * resolved, since the literal reference text is what fails, and names the references that caused a
 * drop. An error also goes when a key its check `reads` is unresolved. Errors about the key itself, and values an env variable supplied, always stay.
 */
export function withoutUnresolvedEnvErrors(
  problems: ReadonlyArray<ConfigProblem>,
  unresolvedFor: (remote: string | undefined) => ReadonlyArray<EnvReference>,
): {
  readonly kept: ReadonlyArray<ConfigProblem>;
  readonly blamed: ReadonlyArray<{ readonly reference: EnvReference; readonly remote?: string }>;
} {
  const blamed: Array<{ readonly reference: EnvReference; readonly remote?: string }> = [];
  const kept = problems.filter((problem) => {
    if (
      problem.severity !== "error" ||
      problem.path === undefined ||
      problem.external !== undefined ||
      !VALUE_LEVEL_CODES.has(problem.code)
    ) {
      return true;
    }
    const { path } = problem;
    const owners = unresolvedFor(problem.remote).filter(
      (reference) =>
        atOrBelow(path, reference.path) ||
        (problem.reads ?? []).some((read) => atOrBelow(reference.path, read)),
    );
    for (const reference of owners) {
      blamed.push({
        reference,
        ...(problem.remote === undefined ? {} : { remote: problem.remote }),
      });
    }
    return owners.length === 0;
  });
  return { kept, blamed };
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
 * The value of the nearest enclosing table's `enabled` switch, trying each representation at every
 * depth before moving outward, or `undefined` when no enclosing table has one.
 */
export function nearestEnabledGate(
  configs: ReadonlyArray<unknown>,
  path: ReadonlyArray<string>,
): boolean | undefined {
  for (let depth = path.length - 1; depth > 0; depth--) {
    for (const config of configs) {
      const enabled = readPath(config, [...path.slice(0, depth), "enabled"]);
      if (typeof enabled === "boolean") return enabled;
    }
  }
  return undefined;
}
