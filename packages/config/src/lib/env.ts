import { Schema, SchemaAST } from "effect";

// Matches `env(...)` references case-insensitively on the captured name — e.g.
// `env(project_id)` is a valid reference, not just SCREAMING_SNAKE_CASE names.
export const ENV_PATTERN = "^env\\((.*)\\)$";
export const ENV_CAPTURE_REGEX = /^env\((.*)\)$/;
// Stricter matcher used when `goViperCompat` is off: only SCREAMING_SNAKE_CASE names match.
export const ENV_CAPTURE_REGEX_STRICT = /^env\(([A-Z_][A-Z0-9_]*)\)$/;
const envRegex = new RegExp(ENV_PATTERN);

export function isEnvReference(value: string, goViperCompat: boolean): boolean {
  return (goViperCompat ? ENV_CAPTURE_REGEX : ENV_CAPTURE_REGEX_STRICT).test(value);
}

interface EnvAnnotations extends Schema.Annotations.Documentation<string> {
  readonly secret?: true;
}

// Marker annotation: this field requires the `env(VAR)` literal form and is
// resolved post-decode via `resolveCliConfigValue` / `resolveCliConfigSubtree`.
// The pre-decode walker honors this and leaves the literal untouched.
const X_ENV_DEFERRED = "x-env-deferred" as const;

export const env = (annotations?: EnvAnnotations) => {
  const { secret, ...rest } = annotations ?? {};
  return Schema.String.check(Schema.isPattern(envRegex)).annotate({
    ...rest,
    [X_ENV_DEFERRED]: true,
    ...(secret ? { "x-secret": true } : {}),
  });
};

interface SecretAnnotations extends Schema.Annotations.Documentation<string> {}

export const secret = (annotations?: SecretAnnotations) =>
  Schema.String.annotate({
    ...annotations,
    "x-secret": true,
  });

type ExpectedType = "number" | "boolean" | "string" | "array" | "unknown";

// Accepted boolean string forms, matching Go's `strconv.ParseBool`; duplicated rather than
// imported so `packages/config` has no dependency on `apps/cli`.
const GO_BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const GO_BOOL_FALSE = new Set(["0", "f", "F", "FALSE", "false", "False", ""]);

// Unwrap Suspend (lazy AST refs from recursive schemas). Other transformation
// wrappers expose the target type via `.ast` directly, so no additional
// unwrapping is needed at this layer.
function unwrapAst(ast: SchemaAST.AST): SchemaAST.AST {
  if (ast._tag === "Suspend") {
    return unwrapAst(ast.thunk());
  }
  return ast;
}

// A homogeneous `Schema.Array(Schema.String)` compiles to an `Arrays` AST node with no fixed
// tuple `elements` and a single `rest` spread type; only this shape (not a fixed tuple or a
// mixed-type array) is eligible for the comma-split coercion below.
function isHomogeneousStringArray(node: SchemaAST.AST): boolean {
  if (node._tag !== "Arrays" || node.elements.length !== 0 || node.rest.length !== 1) {
    return false;
  }
  const spread = node.rest[0];
  return spread !== undefined && unwrapAst(spread)._tag === "String";
}

function leafExpectedType(ast: SchemaAST.AST): ExpectedType {
  const node = unwrapAst(ast);
  switch (node._tag) {
    case "Number":
      return "number";
    case "Boolean":
      return "boolean";
    case "String":
      return "string";
    case "Arrays":
      return isHomogeneousStringArray(node) ? "array" : "unknown";
    case "Union": {
      // Walks branches in declared order; the first concrete primitive wins (e.g. `Number` in
      // `Schema.Union(Schema.Number, Schema.Null)`). Schema decode still validates afterward.
      for (const variant of node.types) {
        const t = leafExpectedType(variant);
        if (t !== "unknown") {
          return t;
        }
      }
      return "unknown";
    }
    default:
      return "unknown";
  }
}

function descendAst(ast: SchemaAST.AST, segment: string): SchemaAST.AST | null {
  const node = unwrapAst(ast);

  if (node._tag === "Objects") {
    const ps = node.propertySignatures.find((p) => p.name === segment);
    if (ps !== undefined) {
      return ps.type;
    }
    // Record-like sections (e.g. `[edge_runtime.secrets]`, `[remotes.<name>]`)
    // express their value shape via index signatures.
    if (node.indexSignatures.length > 0) {
      return node.indexSignatures[0]!.type;
    }
    return null;
  }

  if (node._tag === "Arrays") {
    const index = Number.parseInt(segment, 10);
    if (Number.isInteger(index)) {
      if (index >= 0 && index < node.elements.length) {
        return node.elements[index]!;
      }
      if (node.rest.length > 0) {
        return node.rest[0]!;
      }
    }
    return null;
  }

  if (node._tag === "Union") {
    // Pick the first branch whose descent succeeds.
    for (const variant of node.types) {
      const next = descendAst(variant, segment);
      if (next !== null) {
        return next;
      }
    }
    return null;
  }

  return null;
}

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
    if (GO_BOOL_TRUE.has(value)) return true;
    if (GO_BOOL_FALSE.has(value)) return false;
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
  goViperCompat: boolean,
): { readonly value: string; readonly resolved: boolean; readonly envName?: string } {
  const match = (goViperCompat ? ENV_CAPTURE_REGEX : ENV_CAPTURE_REGEX_STRICT).exec(value);
  if (match === null) {
    return { value, resolved: false };
  }
  const envName = match[1];
  const resolved = envName === undefined ? undefined : env[envName];
  // A present-but-empty var (e.g. a dotenv `KEY=` line) preserves the `env(KEY)` literal, same
  // as an unset key, instead of substituting an empty string.
  if (envName === undefined || resolved === undefined || resolved === "") {
    return { value, resolved: false };
  }
  return { value: resolved, resolved: true, envName };
}

function isDeferredEnvField(ast: SchemaAST.AST): boolean {
  const node = unwrapAst(ast);
  if (node.annotations?.[X_ENV_DEFERRED] === true) {
    return true;
  }
  // The env() helper threads its annotation through `.check(isPattern(...))`,
  // which attaches the metadata to the Filter rather than the base AST.
  for (const check of node.checks ?? []) {
    if (
      (check as { annotations?: Record<string, unknown> }).annotations?.[X_ENV_DEFERRED] === true
    ) {
      return true;
    }
  }
  return false;
}

function walk(
  document: unknown,
  env: Readonly<Record<string, string>>,
  ast: SchemaAST.AST | null,
  goViperCompat: boolean,
  path: ReadonlyArray<string>,
  onResolvedEnv:
    | ((path: ReadonlyArray<string>, envNames: ReadonlyArray<string>) => void)
    | undefined,
): unknown {
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
    const result = document.map((item, index) => {
      const child = ast === null ? null : descendAst(ast, String(index));
      return walk(item, env, child, goViperCompat, [...path, String(index)], onResolvedArrayEnv);
    });
    if (envNames.length > 0) {
      onResolvedEnv?.(path, envNames);
    }
    return result;
  }

  if (typeof document === "object" && document !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document)) {
      const child = ast === null ? null : descendAst(ast, key);
      result[key] = walk(value, env, child, goViperCompat, [...path, key], onResolvedEnv);
    }
    return result;
  }

  if (typeof document === "string") {
    // Fields declared with the `env()` helper require the literal `env(VAR)`
    // form for post-decode resolution. Skip substitution there so the schema
    // pattern check still matches.
    if (ast !== null && isDeferredEnvField(ast)) {
      return document;
    }

    const interpolation = substituteEnvLeaf(document, env, goViperCompat);
    const substituted = interpolation.value;
    if (interpolation.resolved && interpolation.envName !== undefined) {
      onResolvedEnv?.(path, [interpolation.envName]);
    }
    const expected = ast === null ? "unknown" : leafExpectedType(ast);

    // Unlike number/boolean coercion, array coercion also applies to literal strings that never
    // went through env() substitution (e.g. plain TOML `"a,b"`). Gated by `goViperCompat`: off
    // leaves strings unsplit, so an array-typed field fed a string fails decode instead of coercing.
    if (expected === "array") {
      return goViperCompat ? coerceLeaf(substituted, expected) : substituted;
    }

    // Only the substituted form is fed to coercion; literal strings at non-string paths are
    // left untouched so the decoder reports them with their original value.
    if (substituted === document) {
      return document;
    }
    if (ast === null) {
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
export function interpolateEnvReferencesAgainstSchema(
  document: unknown,
  env: Readonly<Record<string, string>>,
  schema: { readonly ast: SchemaAST.AST },
  options?: {
    readonly goViperCompat?: boolean;
    /** Fires per resolved leaf with the substituting env vars' names (array
     * leaves report once at the array path, collecting every element's
     * variable — one array literal may draw on several). */
    readonly onResolvedEnv?: (path: ReadonlyArray<string>, envNames: ReadonlyArray<string>) => void;
  },
): unknown {
  return walk(
    document,
    env,
    schema.ast,
    options?.goViperCompat ?? false,
    [],
    options?.onResolvedEnv,
  );
}
