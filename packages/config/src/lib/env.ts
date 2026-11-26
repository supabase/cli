import { Schema, SchemaAST } from "effect";
import {
  ENV_CAPTURE_REGEX,
  ENV_CAPTURE_REGEX_STRICT,
  ENV_PATTERN,
  interpolateEnvReferences,
  isEnvReference,
  type EnvSchemaNavigator,
  type EnvWalkOptions,
  type ExpectedType,
} from "./env-core.ts";

export { ENV_CAPTURE_REGEX, ENV_CAPTURE_REGEX_STRICT, ENV_PATTERN, isEnvReference };

const envRegex = new RegExp(ENV_PATTERN, "u");

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

// Unwrap Suspend (lazy AST refs from recursive schemas). Other transformation
// wrappers expose the target type via `.ast` directly, so no additional
// unwrapping is needed at this layer.
export function unwrapAst(ast: SchemaAST.AST): SchemaAST.AST {
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

export function leafExpectedType(ast: SchemaAST.AST): ExpectedType {
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

export function descendAst(ast: SchemaAST.AST, segment: string): SchemaAST.AST | null {
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

export function isDeferredEnvField(ast: SchemaAST.AST): boolean {
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

const astNavigator: EnvSchemaNavigator<SchemaAST.AST> = {
  child: descendAst,
  expectedType: leafExpectedType,
  isDeferred: isDeferredEnvField,
};

/**
 * Substitutes `env(VAR)` references against `env` and coerces the result to the schema's
 * expected primitive type at each path. A set-but-empty variable leaves the literal untouched,
 * same as an unset one. Returns a new structure; does not mutate the input.
 */
export function interpolateEnvReferencesAgainstSchema(
  document: unknown,
  env: Readonly<Record<string, string>>,
  schema: { readonly ast: SchemaAST.AST },
  options?: EnvWalkOptions,
): unknown {
  return interpolateEnvReferences(document, env, astNavigator, schema.ast, options);
}

function standInForAst(ast: SchemaAST.AST): unknown {
  const node = unwrapAst(ast);
  switch (node._tag) {
    case "String":
      return "";
    case "Number":
      return 0;
    case "Boolean":
      return false;
    case "Arrays":
      return [];
    case "Objects":
      return {};
    case "Literal":
      return node.literal;
    case "Union": {
      const literal = node.types.map(unwrapAst).find((variant) => variant._tag === "Literal");
      if (literal !== undefined && literal._tag === "Literal") {
        return literal.literal;
      }
      for (const variant of node.types) {
        const standIn = standInForAst(variant);
        if (standIn !== undefined) {
          return standIn;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** A type-correct placeholder for the schema leaf at `path`, or `undefined` if the path does not resolve. */
export function standInAtPath(
  schema: { readonly ast: SchemaAST.AST },
  path: ReadonlyArray<string>,
): unknown {
  let ast: SchemaAST.AST | null = schema.ast;
  for (const segment of path) {
    ast = ast === null ? null : descendAst(ast, segment);
    if (ast === null) {
      return undefined;
    }
  }
  return standInForAst(ast);
}
