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
  node: {
    readonly annotations?: Record<string, unknown>;
    readonly propertySignatures?: ReadonlyArray<{
      readonly name: string;
      readonly type: unknown;
    }>;
    readonly indexSignatures?: ReadonlyArray<{
      readonly type: unknown;
    }>;
  },
  prefix: ReadonlyArray<string> = [],
): Array<ReadonlyArray<string>> {
  const patterns: Array<ReadonlyArray<string>> = [];

  if (node.annotations?.["x-secret"] === true) {
    patterns.push(prefix);
  }

  for (const property of node.propertySignatures ?? []) {
    patterns.push(
      ...collectSecretPathPatterns(
        property.type as Parameters<typeof collectSecretPathPatterns>[0],
        [...prefix, property.name],
      ),
    );
  }

  for (const indexSignature of node.indexSignatures ?? []) {
    patterns.push(
      ...collectSecretPathPatterns(
        indexSignature.type as Parameters<typeof collectSecretPathPatterns>[0],
        [...prefix, "*"],
      ),
    );
  }

  return patterns;
}

// Derived from `CliConfigSchema` once, at module load — the schema's
// annotations are the single source of truth for which paths are secret; no
// hand-maintained list exists alongside it.
const secretPathPatterns = collectSecretPathPatterns(CliConfigSchema.ast as never);

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
