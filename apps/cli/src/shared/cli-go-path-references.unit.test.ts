import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every `new URL("...cli-go/...", import.meta.url)` literal reads an `apps/cli-go/...` path
 * off disk. Those reads only fail when the specific test or script actually runs — a slow,
 * non-default-loop tier for `.e2e.test.ts` files — so a Go-source deletion could silently
 * strand a reference until CI's e2e/live tier executes it. This test enumerates every literal
 * and fails fast in the default unit tier instead.
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
      // Excludes this file itself: its own doc comment and regex source would otherwise
      // match the pattern being scanned for.
      if (sourceFile === thisFile) continue;
      const source = readFileSync(sourceFile, "utf8");
      for (const match of source.matchAll(CLI_GO_URL_LITERAL)) {
        const literal = match[1]!;
        // Mirrors `new URL(literal, import.meta.url)`'s own resolution: relative to the
        // referencing file's directory, with a trailing "/" kept as a directory (`path.resolve`
        // alone drops it).
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
