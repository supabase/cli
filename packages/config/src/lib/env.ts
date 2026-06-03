import { Schema, SchemaAST } from "effect";

export const ENV_PATTERN = "^env\\([A-Z_][A-Z0-9_]*\\)$";
export const ENV_CAPTURE_REGEX = /^env\(([A-Z_][A-Z0-9_]*)\)$/;
const envRegex = new RegExp(ENV_PATTERN);

export function isEnvReference(value: string): boolean {
  return envRegex.test(value);
}

interface EnvAnnotations extends Schema.Annotations.Documentation<string> {
  readonly secret?: true;
}

// Marker annotation: this field requires the `env(VAR)` literal form and is
// resolved post-decode via `resolveProjectValue` / `resolveProjectSubtree`.
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

// ---------------------------------------------------------------------------
// Pre-decode env() interpolation with schema-aware type coercion
// ---------------------------------------------------------------------------
//
// TOML/JSON parsers turn `port = "env(SUPABASE_ANALYTICS_PORT)"` into a string
// at `analytics.port`, but the schema declares `port: Schema.Number`. Without
// pre-decode handling the strict decoder rejects the string and crashes
// `supabase db start` (CLI-1489).
//
// `interpolateEnvReferencesAgainstSchema` walks the parsed document and the
// schema AST in parallel:
//   - For string leaves matching `env(VAR)`: substitute `env[VAR]` if set, or
//     preserve the literal verbatim if unset (matches Go's
//     `apps/cli-go/pkg/config/decode_hooks.go:14-21`).
//   - After substitution, if the schema at that path expects Number or Boolean
//     and the value is still a string, coerce it. This mirrors Go's
//     mapstructure chain where `LoadEnvHook` returns a string and subsequent
//     hooks convert it to the target type.
//   - Coercion is only attempted on strings produced by env() substitution.
//     Pre-existing string literals at non-string paths are left untouched —
//     they'll surface as schema errors at decode time with their original
//     value, preserving error clarity.

type ExpectedType = "number" | "boolean" | "string" | "unknown";

// Unwrap Suspend (lazy AST refs from recursive schemas). Other transformation
// wrappers expose the target type via `.ast` directly, so no additional
// unwrapping is needed at this layer.
function unwrapAst(ast: SchemaAST.AST): SchemaAST.AST {
  if (ast._tag === "Suspend") {
    return unwrapAst(ast.thunk());
  }
  return ast;
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
    case "Union": {
      // Walk Union branches in declared order; first concrete primitive wins.
      // For unions like `Schema.Union(Schema.Number, Schema.Null)` this picks
      // the meaningful side. If the union mixes Number and String we err on
      // the side of the first match — the schema decode will still validate
      // membership after coercion.
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
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  return value;
}

function substituteEnvLeaf(value: string, env: Readonly<Record<string, string>>): string {
  const match = ENV_CAPTURE_REGEX.exec(value);
  if (match === null) {
    return value;
  }
  const envName = match[1];
  if (envName === undefined || !Object.prototype.hasOwnProperty.call(env, envName)) {
    return value;
  }
  return env[envName] ?? value;
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
): unknown {
  if (Array.isArray(document)) {
    return document.map((item, index) => {
      const child = ast === null ? null : descendAst(ast, String(index));
      return walk(item, env, child);
    });
  }

  if (typeof document === "object" && document !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document)) {
      const child = ast === null ? null : descendAst(ast, key);
      result[key] = walk(value, env, child);
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
    // Substitute env() then coerce based on the schema's expected type at this
    // path. Only the substituted form is fed to coercion — literal strings at
    // non-string paths are left untouched so the decoder can report them with
    // their original value.
    const substituted = substituteEnvLeaf(document, env);
    if (substituted === document) {
      return document;
    }
    if (ast === null) {
      return substituted;
    }
    return coerceLeaf(substituted, leafExpectedType(ast));
  }

  return document;
}

/**
 * Pre-decode env() substitution + schema-aware coercion.
 *
 * Walks the raw parsed document and the schema AST in parallel. For every
 * string leaf matching `env(VAR)`:
 *   1. Substitutes `env[VAR]` if set, else preserves the literal verbatim
 *      (Go-parity with `apps/cli-go/pkg/config/decode_hooks.go:14-21`).
 *   2. If the schema at that path expects Number or Boolean, coerces the
 *      substituted string to the expected primitive — mirroring Go's
 *      mapstructure chain where `LoadEnvHook` returns a string that the next
 *      hook converts to the target type.
 *
 * Returns a new structure; does not mutate the input.
 */
export function interpolateEnvReferencesAgainstSchema(
  document: unknown,
  env: Readonly<Record<string, string>>,
  schema: { readonly ast: SchemaAST.AST },
): unknown {
  return walk(document, env, schema.ast);
}
