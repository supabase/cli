import { Schema, SchemaAST } from "effect";

// Go's `LoadEnvHook` matcher (`apps/cli-go/pkg/config/decode_hooks.go:11`) is
// `^env\((.*)\)$` — permissive on the captured name's case/content, and
// reused verbatim for secrets (`secret.go:99`) and the unset-var warning
// (`config.go:1195`). Matching that exactly (not an uppercase-only
// restriction) so e.g. `project_id = "env(project_id)"` substitutes the same
// way it does in the Go CLI.
export const ENV_PATTERN = "^env\\((.*)\\)$";
export const ENV_CAPTURE_REGEX = /^env\((.*)\)$/;
// Pre-PR-#5765 strict matcher: SCREAMING_SNAKE_CASE names only. Selected when
// `goViperCompat` is off so non-Go-parity surfaces (next/, packages/stack, the
// functions manifest) keep the narrower matching they had before PR #5765
// widened env() resolution to Go's case-agnostic `^env\((.*)\)$`.
export const ENV_CAPTURE_REGEX_STRICT = /^env\(([A-Z_][A-Z0-9_]*)\)$/;
const envRegex = new RegExp(ENV_PATTERN);

export function isEnvReference(value: string, goViperCompat: boolean): boolean {
  return (goViperCompat ? ENV_CAPTURE_REGEX : ENV_CAPTURE_REGEX_STRICT).test(value);
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
//   - Number/boolean coercion is only attempted on strings produced by env()
//     substitution. Pre-existing string literals at non-string paths are left
//     untouched — they'll surface as schema errors at decode time with their
//     original value, preserving error clarity.
//   - Array coercion is the one exception: if the schema at that path expects
//     a homogeneous string array, ANY string leaf (substituted or a plain
//     literal) is split on `,` — mirroring Go's `StringToSliceHookFunc(",")`
//     (`apps/cli-go/pkg/config/config.go:775-784`), which is wired
//     unconditionally into the decode hook chain regardless of where the
//     string came from (e.g. `additional_redirect_urls = "http://a,http://b"`
//     decodes fine in Go today, not just via `env(...)`).

type ExpectedType = "number" | "boolean" | "string" | "array" | "unknown";

// Go decodes an env()-substituted boolean via mapstructure's weakly-typed
// `decodeBool`, which runs `strconv.ParseBool` on the string — a wider
// acceptance set than the literal `"true"`/`"false"` this module used to
// require. Mirrors `legacyParseGoBool`'s `GO_BOOL_TRUE`/`GO_BOOL_FALSE`
// (`apps/cli/src/legacy/shared/legacy-db-config.toml-read.ts:615-616`);
// duplicated here (not imported) so `packages/config` doesn't depend on
// `apps/cli`.
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

// A homogeneous `Schema.Array(Schema.String)` compiles to an `Arrays` AST
// node with no fixed tuple `elements` and a single `rest` spread type. Only
// this shape (not a fixed string tuple, and not a mixed-type array) is
// eligible for Go's `StringToSliceHookFunc(",")` coercion below — mirroring
// that Go itself only wires the hook for `[]string`-kind targets
// (`apps/cli-go/pkg/config/config.go:775-784`), not fixed-arity tuples.
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
    if (GO_BOOL_TRUE.has(value)) return true;
    if (GO_BOOL_FALSE.has(value)) return false;
    return value;
  }
  if (expected === "array") {
    // Go's `mapstructure.StringToSliceHookFunc(",")` (wired in
    // `apps/cli-go/pkg/config/config.go:775-784`): an empty string decodes to
    // an empty slice, otherwise the string is split on the separator with no
    // further trimming of the resulting elements.
    return value === "" ? [] : value.split(",");
  }
  return value;
}

function substituteEnvLeaf(
  value: string,
  env: Readonly<Record<string, string>>,
  goViperCompat: boolean,
): string {
  const match = (goViperCompat ? ENV_CAPTURE_REGEX : ENV_CAPTURE_REGEX_STRICT).exec(value);
  if (match === null) {
    return value;
  }
  const envName = match[1];
  const resolved = envName === undefined ? undefined : env[envName];
  // Go's LoadEnvHook only substitutes when the env var is non-empty
  // (`apps/cli-go/pkg/config/decode_hooks.go:19-24`: `len(env) > 0`), so a
  // key that's present but empty (e.g. a dotenv `KEY=` line) preserves the
  // `env(KEY)` literal exactly like an unset key, rather than substituting "".
  if (resolved === undefined || resolved === "") {
    return value;
  }
  return resolved;
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
): unknown {
  if (Array.isArray(document)) {
    return document.map((item, index) => {
      const child = ast === null ? null : descendAst(ast, String(index));
      return walk(item, env, child, goViperCompat);
    });
  }

  if (typeof document === "object" && document !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document)) {
      const child = ast === null ? null : descendAst(ast, key);
      result[key] = walk(value, env, child, goViperCompat);
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

    const substituted = substituteEnvLeaf(document, env, goViperCompat);
    const expected = ast === null ? "unknown" : leafExpectedType(ast);

    // Go's `StringToSliceHookFunc(",")` (`apps/cli-go/pkg/config/config.go:
    // 775-784`) is wired unconditionally into `v.UnmarshalExact`'s decode
    // hook chain, so it splits ANY string being decoded into a `[]string`
    // field — a plain TOML literal (`additional_redirect_urls = "a,b"`) just
    // as much as an `env()`-substituted one. Unlike the number/boolean
    // coercion below (scoped to substituted values only, since TOML already
    // decodes literal numbers/booleans to their native type), array coercion
    // must also apply to literal strings that never went through
    // `substituteEnvLeaf`. Gated by `goViperCompat`: when off, the string is
    // left unsplit — literal and substituted alike — so an array-typed field
    // fed a string fails decode instead of silently coercing, matching
    // pre-PR-#5765 behavior.
    if (expected === "array") {
      return goViperCompat ? coerceLeaf(substituted, expected) : substituted;
    }

    // Substitute env() then coerce based on the schema's expected type at this
    // path. Only the substituted form is fed to coercion — literal strings at
    // non-string paths are left untouched so the decoder can report them with
    // their original value.
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
 * Pre-decode env() substitution + schema-aware coercion.
 *
 * Walks the raw parsed document and the schema AST in parallel. For every
 * string leaf matching `env(VAR)`:
 *   1. Substitutes `env[VAR]` if set AND non-empty, else preserves the
 *      literal verbatim (Go-parity with
 *      `apps/cli-go/pkg/config/decode_hooks.go:14-21`, which gates on
 *      `len(env) > 0` — a set-but-empty var, e.g. a dotenv `KEY=` line,
 *      leaves the `env(KEY)` literal untouched just like an unset one).
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
  options?: { readonly goViperCompat?: boolean },
): unknown {
  return walk(document, env, schema.ast, options?.goViperCompat ?? false);
}
