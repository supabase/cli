import { CliConfigSchema } from "../base.ts";

/**
 * Schema-derived `x-secret` leaf paths under {@link CliConfigSchema}, and the
 * predicate built on top of them. Extracted from `../project.ts` (CLI-2230's
 * secret-omission finding): `../project.ts` sits outside the pure browser-safe
 * graph (`../entrypoint-purity.unit.test.ts`'s `expectedPureGraphFiles`) — it
 * imports `effect`'s `FileSystem`/`Redacted` platform surface — while
 * `../project-config/project-config.ts` (which needs this same predicate to
 * omit secret leaves from a document-sourced `ProjectConfig`) is itself part
 * of that pure graph. Moving the collector here, rather than duplicating it,
 * gives both callers one source of truth for "which `CliConfig` paths are
 * `x-secret`", per this repo's policy of moving code to its correct owner
 * over duplicating it.
 */
function collectSecretPathPatterns(
  node: unknown,
  prefix: ReadonlyArray<string> = [],
): Array<ReadonlyArray<string>> {
  // The walker narrows each AST piece structurally instead of asserting a
  // node shape: an AST change then makes the walk find nothing (which the
  // exhaustive secret-strip test catches as a vanished pattern set) rather
  // than silently reading through a stale asserted shape.
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
 * Derived from `CliConfigSchema` once, at module load — the schema's
 * annotations are the single source of truth for which paths are secret; no
 * hand-maintained list exists alongside it. A pattern segment is either a
 * literal key or `"*"` (a dynamic `Schema.Record` key, e.g. `db.vault.*`,
 * `edge_runtime.secrets.*`, `remotes.*.auth.jwt_secret`). Exported (beyond
 * {@link isSecretPath}) so `../project-config/project-config.unit.test.ts`
 * can build an exhaustive secret-strip probe from the same source of truth,
 * rather than a second hand-picked field list.
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
