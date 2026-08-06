import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards against exactly the failure mode found and fixed in CLI-1966: a test
 * or build script reading an `apps/cli-go/...` path directly off disk via
 * `new URL("...cli-go/...", import.meta.url)` (see e.g. the fixed
 * `shared/functions/serve-main-offline.e2e.test.ts`, which read the now-deleted
 * `internal/start/templates/kong.yml`). Those reads only fail loudly when the
 * specific test/script actually runs -- for an `.e2e.test.ts` file that's a
 * slow, non-default-loop tier (see `apps/cli/CLAUDE.md`'s "Testing" section),
 * so a Go-source deletion elsewhere in this milestone could silently strand
 * one of these until CI's e2e/live tier finally executes it. This test
 * enumerates every such literal across the repo and fails fast, in the
 * default unit tier, the moment the referenced path stops existing.
 */

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const scanDirs = [path.join(repoRoot, "apps/cli/src"), path.join(repoRoot, "apps/cli/scripts")];

// Matches `new URL("<relative-path-containing-cli-go>", import.meta.url)`.
const CLI_GO_URL_LITERAL =
  /new\s+URL\(\s*["'`]([^"'`]*cli-go[^"'`]*)["'`]\s*,\s*import\.meta\.url\s*\)/g;

interface Reference {
  readonly sourceFile: string;
  readonly literal: string;
  readonly resolved: string;
}

const thisFile = fileURLToPath(import.meta.url);

function walk(dir: string): Array<string> {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) return walk(fullPath);
    return fullPath.endsWith(".ts") ? [fullPath] : [];
  });
}

function findCliGoReferences(): Array<Reference> {
  const references: Array<Reference> = [];
  for (const dir of scanDirs) {
    for (const sourceFile of walk(dir)) {
      // Excludes this file itself -- its own doc comment and regex source
      // above are themselves full of literal text that would otherwise
      // match the pattern being scanned for.
      if (sourceFile === thisFile) continue;
      const source = readFileSync(sourceFile, "utf8");
      for (const match of source.matchAll(CLI_GO_URL_LITERAL)) {
        const literal = match[1]!;
        // Mirrors `new URL(literal, import.meta.url)`'s own resolution: relative
        // to the referencing file's own directory, treating a trailing "/" as a
        // directory (matching WHATWG URL semantics, unlike path.resolve alone).
        const resolved = literal.endsWith("/")
          ? `${path.resolve(path.dirname(sourceFile), literal)}/`
          : path.resolve(path.dirname(sourceFile), literal);
        references.push({ sourceFile, literal, resolved });
      }
    }
  }
  return references;
}

describe("apps/cli-go path references", () => {
  it('every `new URL(".../cli-go/...")` literal resolves to a path that still exists', () => {
    const references = findCliGoReferences();

    // Sanity check on the checker itself: fail loudly (rather than passing
    // vacuously) if the scan somehow stops finding any references at all.
    expect(references.length).toBeGreaterThan(0);

    const missing = references
      .filter((ref) => !existsSync(ref.resolved.replace(/\/$/, "")))
      .map((ref) => `${path.relative(repoRoot, ref.sourceFile)}: "${ref.literal}"`);

    expect(missing).toEqual([]);
  });
});
