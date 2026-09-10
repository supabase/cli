import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the telemetry identity of every CLI error.
 *
 * The string passed to `Data.TaggedError("...")` is not cosmetic: it flows
 * straight into the `error_fingerprint` property on the `cli_command_executed`
 * PostHog event (as `tag:<TagName>`, sometimes with a `:suffix`). Renaming the
 * *class* is free -- the tag is looked up independently by convention, not by
 * class identity -- but changing the *string literal* silently splits one
 * error's history into two fingerprints with no error, no warning, and no
 * easy way to notice until repeat-rate/trend dashboards look wrong months
 * later.
 *
 * This suite enumerates every `Data.TaggedError("...")` declaration under
 * `apps/cli/src` (including the multi-line form the formatter produces for
 * long class names) and compares the resulting set of tag literals against
 * the committed snapshot in `__fixtures__/error-tags.txt`.
 */

const srcDir = fileURLToPath(new URL("../..", import.meta.url));
const fixturesDir = fileURLToPath(new URL("./__fixtures__", import.meta.url));

// Matches both the inline declaration form and the formatter-wrapped
// multi-line form, where the string literal lands on its own line before the
// closing paren.
const TAGGED_ERROR_PATTERN = /class\s+(\w+)\s+extends\s+Data\.TaggedError\(\s*["']([^"']+)["']/g;

interface TaggedErrorDeclaration {
  readonly className: string;
  readonly tag: string;
  readonly file: string;
}

function walk(dir: string): Array<string> {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "__fixtures__") return [];
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) return walk(fullPath);
    return fullPath.endsWith(".ts") && !fullPath.endsWith(".d.ts") ? [fullPath] : [];
  });
}

function isProductionSourceFile(filePath: string): boolean {
  return (
    !filePath.endsWith(".unit.test.ts") &&
    !filePath.endsWith(".integration.test.ts") &&
    !filePath.endsWith(".e2e.test.ts")
  );
}

function collectTaggedErrorDeclarations(
  filePaths: ReadonlyArray<string>,
): Array<TaggedErrorDeclaration> {
  const declarations: Array<TaggedErrorDeclaration> = [];
  for (const filePath of filePaths) {
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(TAGGED_ERROR_PATTERN)) {
      declarations.push({
        className: match[1]!,
        tag: match[2]!,
        file: path.relative(srcDir, filePath),
      });
    }
  }
  return declarations;
}

function readSnapshotTags(): Array<string> {
  return readFileSync(path.join(fixturesDir, "error-tags.txt"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

const allFiles = walk(srcDir);
const allDeclarations = collectTaggedErrorDeclarations(allFiles);
const productionDeclarations = collectTaggedErrorDeclarations(
  allFiles.filter(isProductionSourceFile),
);

describe("error tag stability", () => {
  it("keeps every Data.TaggedError tag literal identical to the committed snapshot", () => {
    const currentTags = [...new Set(allDeclarations.map((declaration) => declaration.tag))].sort();
    const snapshotTags = readSnapshotTags();

    const added = currentTags.filter((tag) => !snapshotTags.includes(tag));
    const removed = snapshotTags.filter((tag) => !currentTags.includes(tag));

    expect(
      { added, removed },
      'A Data.TaggedError("...") tag literal was added, removed, or changed. That string is the ' +
        "error's telemetry identity in PostHog -- it flows into error_fingerprint as `tag:<TagName>` on " +
        "the cli_command_executed event. Changing it silently splits one error's history into two " +
        "fingerprints, with no error and no warning, breaking repeat-rate and trend continuity. " +
        "Renaming the error CLASS is fine; do NOT change the string literal passed to " +
        "Data.TaggedError(...) when you do it. If this change is an intentional, reviewed identity " +
        "change (not an accidental rename), update " +
        "apps/cli/src/shared/telemetry/__fixtures__/error-tags.txt to match.",
    ).toEqual({ added: [], removed: [] });
  });

  it("never lets two differently-named error classes share the same tag literal", () => {
    const classNamesByTag = new Map<string, Set<string>>();
    for (const declaration of productionDeclarations) {
      const names = classNamesByTag.get(declaration.tag) ?? new Set<string>();
      names.add(declaration.className);
      classNamesByTag.set(declaration.tag, names);
    }

    const collisions = [...classNamesByTag.entries()]
      .filter(([, names]) => names.size > 1)
      .map(([tag, names]) => `"${tag}" used by: ${[...names].sort().join(", ")}`);

    expect(
      collisions,
      'Two differently-named error classes pass the same string to Data.TaggedError("..."). Since ' +
        "that string is the telemetry identity reported to PostHog, this makes two conceptually " +
        "different errors indistinguishable in error_fingerprint. Give each class its own tag literal.",
    ).toEqual([]);
  });
});
