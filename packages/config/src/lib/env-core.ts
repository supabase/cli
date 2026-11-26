// Matches `env(...)` references case-insensitively on the captured name — e.g.
// `env(project_id)` is a valid reference, not just SCREAMING_SNAKE_CASE names.
export const ENV_PATTERN = "^env\\((.*)\\)$";
export const ENV_CAPTURE_REGEX = /^env\((.*)\)$/;
// Stricter matcher used when `cliCompat` is off: only SCREAMING_SNAKE_CASE names match.
export const ENV_CAPTURE_REGEX_STRICT = /^env\(([A-Z_][A-Z0-9_]*)\)$/;

export function isEnvReference(value: string, cliCompat: boolean): boolean {
  return (cliCompat ? ENV_CAPTURE_REGEX : ENV_CAPTURE_REGEX_STRICT).test(value);
}

export type ExpectedType = "number" | "boolean" | "string" | "array" | "unknown";

/** How the env walker reads a schema; `N` is whatever node type the schema representation uses. */
export interface EnvSchemaNavigator<N> {
  readonly child: (node: N, segment: string) => N | null;
  readonly expectedType: (node: N) => ExpectedType;
  readonly isDeferred: (node: N) => boolean;
}

export interface EnvWalkOptions {
  readonly cliCompat?: boolean;
  /** Fires per resolved leaf with the substituting env vars' names (array leaves report once at the array path, collecting every element's variable). */
  readonly onResolvedEnv?: (path: ReadonlyArray<string>, envNames: ReadonlyArray<string>) => void;
  /** A leaf or array at a path this returns true for is kept verbatim, already resolved. */
  readonly skip?: (path: ReadonlyArray<string>) => boolean;
  /** Fires per `env(NAME)` leaf outside deferred fields, resolved or not; array leaves report once per name at the outermost array path. */
  readonly onEnvReference?: (path: ReadonlyArray<string>, name: string) => void;
}

// Accepted boolean string forms (`1`/`t`/`T`/`TRUE`/`true`/`True`, `0`/`f`/`F`/`FALSE`/`false`/`False`); duplicated rather than
// imported so `packages/config` has no dependency on `apps/cli`.
const BOOL_TRUE_LITERALS = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const BOOL_FALSE_LITERALS = new Set(["0", "f", "F", "FALSE", "false", "False", ""]);

function coerceLeaf(value: unknown, expected: ExpectedType): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (expected === "number") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return value;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      return n;
    }
    return value;
  }
  if (expected === "boolean") {
    if (BOOL_TRUE_LITERALS.has(value)) return true;
    if (BOOL_FALSE_LITERALS.has(value)) return false;
    return value;
  }
  if (expected === "array") {
    // An empty string decodes to an empty array; otherwise split on `,` with no trimming.
    return value === "" ? [] : value.split(",");
  }
  return value;
}

function substituteEnvLeaf(
  value: string,
  env: Readonly<Record<string, string>>,
  cliCompat: boolean,
): {
  readonly value: string;
  readonly resolved: boolean;
  readonly envName?: string;
  readonly referenced?: string;
} {
  const match = (cliCompat ? ENV_CAPTURE_REGEX : ENV_CAPTURE_REGEX_STRICT).exec(value);
  if (match === null) {
    return { value, resolved: false };
  }
  const envName = match[1];
  const resolved = envName !== undefined && Object.hasOwn(env, envName) ? env[envName] : undefined;
  // A present-but-empty var (e.g. a dotenv `KEY=` line) preserves the `env(KEY)` literal, same
  // as an unset key, instead of substituting an empty string.
  if (envName === undefined || resolved === undefined || resolved === "") {
    return { value, resolved: false, referenced: envName };
  }
  return { value: resolved, resolved: true, envName, referenced: envName };
}

function walk<N>(
  document: unknown,
  env: Readonly<Record<string, string>>,
  navigator: EnvSchemaNavigator<N>,
  node: N | null,
  cliCompat: boolean,
  path: ReadonlyArray<string>,
  onResolvedEnv: EnvWalkOptions["onResolvedEnv"],
  skip: EnvWalkOptions["skip"],
  onEnvReference: EnvWalkOptions["onEnvReference"],
): unknown {
  if (skip?.(path) === true) {
    return document;
  }

  if (Array.isArray(document)) {
    // Element-level resolutions are reported once, at the array's own path —
    // one array literal may draw on several env vars, so the names collect.
    const envNames: Array<string> = [];
    const onResolvedArrayEnv =
      onResolvedEnv === undefined
        ? undefined
        : (_: ReadonlyArray<string>, resolvedNames: ReadonlyArray<string>) => {
            for (const envName of resolvedNames) {
              if (!envNames.includes(envName)) {
                envNames.push(envName);
              }
            }
          };
    const referencedNames: Array<string> = [];
    const onArrayEnvReference =
      onEnvReference === undefined
        ? undefined
        : (_: ReadonlyArray<string>, name: string) => {
            if (!referencedNames.includes(name)) {
              referencedNames.push(name);
            }
          };
    const result = document.map((item, index) => {
      const child = node === null ? null : navigator.child(node, String(index));
      return walk(
        item,
        env,
        navigator,
        child,
        cliCompat,
        [...path, String(index)],
        onResolvedArrayEnv,
        skip,
        onArrayEnvReference,
      );
    });
    if (envNames.length > 0) {
      onResolvedEnv?.(path, envNames);
    }
    for (const name of referencedNames) {
      onEnvReference?.(path, name);
    }
    return result;
  }

  if (typeof document === "object" && document !== null) {
    return Object.fromEntries(
      Object.entries(document).map(([key, value]) => {
        const child = node === null ? null : navigator.child(node, key);
        return [
          key,
          walk(
            value,
            env,
            navigator,
            child,
            cliCompat,
            [...path, key],
            onResolvedEnv,
            skip,
            onEnvReference,
          ),
        ];
      }),
    );
  }

  if (typeof document === "string") {
    // Fields declared with the `env()` helper require the literal `env(VAR)`
    // form for post-decode resolution. Skip substitution there so the schema
    // pattern check still matches.
    if (node !== null && navigator.isDeferred(node)) {
      return document;
    }

    const interpolation = substituteEnvLeaf(document, env, cliCompat);
    if (interpolation.referenced !== undefined) {
      onEnvReference?.(path, interpolation.referenced);
    }
    const substituted = interpolation.value;
    if (interpolation.resolved && interpolation.envName !== undefined) {
      onResolvedEnv?.(path, [interpolation.envName]);
    }
    const expected = node === null ? "unknown" : navigator.expectedType(node);

    // Unlike number/boolean coercion, array coercion also applies to literal strings that never
    // went through env() substitution (e.g. plain TOML `"a,b"`). Gated by `cliCompat`: off
    // leaves strings unsplit, so an array-typed field fed a string fails decode instead of coercing.
    if (expected === "array") {
      return cliCompat ? coerceLeaf(substituted, expected) : substituted;
    }

    // Only the substituted form is fed to coercion; literal strings at non-string paths are
    // left untouched so the decoder reports them with their original value.
    if (substituted === document) {
      return document;
    }
    if (node === null) {
      return substituted;
    }
    return coerceLeaf(substituted, expected);
  }

  return document;
}

/**
 * Substitutes `env(VAR)` references against `env` and coerces the result to the schema's
 * expected primitive type at each path. A set-but-empty variable leaves the literal untouched,
 * same as an unset one. Returns a new structure; does not mutate the input.
 */
export function interpolateEnvReferences<N>(
  document: unknown,
  env: Readonly<Record<string, string>>,
  navigator: EnvSchemaNavigator<N>,
  root: N,
  options?: EnvWalkOptions,
): unknown {
  return walk(
    document,
    env,
    navigator,
    root,
    options?.cliCompat ?? false,
    [],
    options?.onResolvedEnv,
    options?.skip,
    options?.onEnvReference,
  );
}
