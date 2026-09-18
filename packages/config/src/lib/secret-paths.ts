import { CliConfigSchema } from "../base.ts";

// Lives here (not `../project.ts`) so `../project-config/project-config.ts`, which needs the
// same secret predicate, doesn't have to import `../project.ts`'s platform-specific graph.
function collectSecretPathPatterns(
  node: unknown,
  prefix: ReadonlyArray<string> = [],
): Array<ReadonlyArray<string>> {
  // Narrows each AST piece structurally rather than asserting a shape, so an AST change makes
  // the walk find nothing (caught by the exhaustive secret-strip test) instead of silently
  // reading through a stale assertion.
  const patterns: Array<ReadonlyArray<string>> = [];
  if (!isAstNodeLike(node)) {
    return patterns;
  }

  const annotations = node["annotations"];
  if (isAstNodeLike(annotations) && annotations["x-secret"] === true) {
    patterns.push(prefix);
  }

  const propertySignatures = node["propertySignatures"];
  if (Array.isArray(propertySignatures)) {
    for (const property of propertySignatures) {
      if (!isAstNodeLike(property)) {
        continue;
      }
      const name = property["name"];
      if (typeof name !== "string") {
        continue;
      }
      patterns.push(...collectSecretPathPatterns(property["type"], [...prefix, name]));
    }
  }

  const indexSignatures = node["indexSignatures"];
  if (Array.isArray(indexSignatures)) {
    for (const indexSignature of indexSignatures) {
      if (!isAstNodeLike(indexSignature)) {
        continue;
      }
      patterns.push(...collectSecretPathPatterns(indexSignature["type"], [...prefix, "*"]));
    }
  }

  return patterns;
}

/** AST nodes are class instances, so this is a keyed-access guard, not a plain-object check. */
function isAstNodeLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Every `x-secret` leaf path in {@link CliConfigSchema}, derived once at module load. A pattern
 * segment is either a literal key or `"*"` for a dynamic `Schema.Record` key (e.g. `db.vault.*`).
 */
export const secretPathPatterns = collectSecretPathPatterns(CliConfigSchema.ast);

function matchesPathPattern(
  pattern: ReadonlyArray<string>,
  actual: ReadonlyArray<string>,
): boolean {
  if (pattern.length !== actual.length) {
    return false;
  }

  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== "*" && pattern[index] !== actual[index]) {
      return false;
    }
  }

  return true;
}

/** Whether `path` (root-relative segments into {@link CliConfigSchema}) names an `x-secret` leaf. */
export function isSecretPath(path: ReadonlyArray<string>): boolean {
  return secretPathPatterns.some((pattern) => matchesPathPattern(pattern, path));
}
