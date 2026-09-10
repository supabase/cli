import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the telemetry identity of every CLI error: the string passed to
 * `Data.TaggedError("...")` becomes `error_fingerprint` on the `cli_command_executed` event, so
 * changing it (not renaming the class) silently splits one error's history into two
 * fingerprints, undetected until dashboards look wrong.
 *
 * Enumerates every production `Data.TaggedError` tag under `apps/cli/src` and
 * `packages/config/src`, resolving tags built via template interpolation
 * (`mintConfigTargetErrors`) at runtime by constructing each class — see
 * {@link collectComputedTagDeclarations}. Compares the set against the committed
 * `__fixtures__/error-tags.txt` snapshot.
 *
 * Known gap: the snapshot is a set, not an owner-to-tag mapping, so two classes swapping tags
 * in one change would pass undetected — accepted to avoid breaking ordinary class renames.
 */

const cliSrcDir = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const externalConfigSrcDir = path.join(repoRoot, "packages/config/src");
const fixturesDir = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const fixturePath = path.join(fixturesDir, "error-tags.txt");

// Matches both the inline declaration form and the formatter-wrapped
// multi-line form, where the string literal lands on its own line before the
// closing paren.
const TAGGED_ERROR_PATTERN = /class\s+(\w+)\s+extends\s+Data\.TaggedError\(\s*["']([^"']+)["']/g;

// Every test tier this repo's vitest config defines (`apps/cli/vitest.config.ts`).
// Shared by name so a fifth tier can't quietly slip past `isProductionSourceFile`
// the way `.live.test.ts` originally did.
const TEST_FILE_SUFFIXES = [
  ".unit.test.ts",
  ".integration.test.ts",
  ".e2e.test.ts",
  ".live.test.ts",
] as const;

/**
 * Files whose tags `mintConfigTargetErrors` computes via template interpolation, resolved at
 * runtime instead of by static regex. Also the list {@link collectStaticDeclarations} skips to
 * avoid double-counting. Paths are relative to `cliSrcDir`.
 */
const COMPUTED_TAG_SOURCE_FILES: ReadonlyArray<string> = [
  "commands/config/pull/pull.errors.ts",
  "commands/config/diff/diff.errors.ts",
  "commands/config/push/push.errors.ts",
  "commands/pull/pull.errors.ts",
];
const computedTagSourceFileSet = new Set(COMPUTED_TAG_SOURCE_FILES);

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
  return !TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

/**
 * Statically regexes every `Data.TaggedError("...")` string-literal declaration out of the
 * given production files, skipping `COMPUTED_TAG_SOURCE_FILES` (those come from
 * {@link collectComputedTagDeclarations} instead) so a file never contributes twice.
 */
function collectStaticDeclarations(
  filePaths: ReadonlyArray<string>,
  rootDir: string,
): Array<TaggedErrorDeclaration> {
  const declarations: Array<TaggedErrorDeclaration> = [];
  for (const filePath of filePaths) {
    const relativeToRoot = path.relative(rootDir, filePath);
    if (rootDir === cliSrcDir && computedTagSourceFileSet.has(relativeToRoot)) continue;
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(TAGGED_ERROR_PATTERN)) {
      declarations.push({
        className: match[1]!,
        tag: match[2]!,
        file: path.relative(repoRoot, filePath),
      });
    }
  }
  return declarations;
}

/**
 * Runtime half of the computed-tag guard: imports each `COMPUTED_TAG_SOURCE_FILES` module,
 * constructs every exported class, and reads its real, fully-interpolated `_tag` off the
 * instance — a source-text regex can't see `` Data.TaggedError(`${prefix}...`) ``.
 *
 * `new Export({})` is safe because every export here is a `Data.TaggedError`-derived class
 * whose generated constructor assigns whatever properties are present without validating them.
 */
async function collectComputedTagDeclarations(): Promise<Array<TaggedErrorDeclaration>> {
  const declarations: Array<TaggedErrorDeclaration> = [];
  for (const relativeFile of COMPUTED_TAG_SOURCE_FILES) {
    const moduleUrl = pathToFileURL(path.join(cliSrcDir, relativeFile)).href;
    const module: Record<string, unknown> = await import(moduleUrl);
    for (const [exportName, exportValue] of Object.entries(module)) {
      if (typeof exportValue !== "function") continue;
      let tag: unknown;
      try {
        const Ctor = exportValue as new (args: Record<string, unknown>) => { _tag?: unknown };
        tag = new Ctor({})._tag;
      } catch {
        continue; // Not a constructible Data.TaggedError-shaped export.
      }
      if (typeof tag !== "string") continue;
      declarations.push({ className: exportName, tag, file: `apps/cli/src/${relativeFile}` });
    }
  }
  return declarations;
}

/** Shared comparator for the fixture and the live scan, so a `localeCompare`-vs-default-sort
 * mismatch can't make the comparison lie. */
function compareTags(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readSnapshotTags(): Array<string> {
  return readFileSync(fixturePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

/** Every production `Data.TaggedError` declaration, static and computed alike. */
async function collectProductionDeclarations(): Promise<Array<TaggedErrorDeclaration>> {
  const cliFiles = walk(cliSrcDir).filter(isProductionSourceFile);
  const externalFiles = walk(externalConfigSrcDir).filter(isProductionSourceFile);
  const staticDeclarations = [
    ...collectStaticDeclarations(cliFiles, cliSrcDir),
    ...collectStaticDeclarations(externalFiles, externalConfigSrcDir),
  ];
  const computedDeclarations = await collectComputedTagDeclarations();
  return [...staticDeclarations, ...computedDeclarations];
}

/**
 * Regenerates `__fixtures__/error-tags.txt` from the current, live tag set.
 * Run with:
 *
 *   UPDATE_ERROR_TAGS_FIXTURE=1 bun --bun vitest run --project unit -t "error tag stability"
 *
 * Only ever do this after confirming the `added`/`removed` diff below is an
 * intentional, reviewed identity change -- not an accidental rename.
 */
function writeFixture(tags: ReadonlySet<string>): void {
  const sorted = [...tags].sort(compareTags);
  writeFileSync(fixturePath, sorted.map((tag) => `${tag}\n`).join(""));
}

describe("error tag stability", () => {
  it("keeps every Data.TaggedError tag literal identical to the committed snapshot", async () => {
    const productionDeclarations = await collectProductionDeclarations();
    const currentTagSet = new Set(productionDeclarations.map((declaration) => declaration.tag));

    if (process.env["UPDATE_ERROR_TAGS_FIXTURE"] === "1") {
      writeFixture(currentTagSet);
    }

    const currentTags = [...currentTagSet].sort(compareTags);
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
        "change (not an accidental rename), regenerate the snapshot with " +
        '`UPDATE_ERROR_TAGS_FIXTURE=1 bun --bun vitest run --project unit -t "error tag stability"` ' +
        "and commit the resulting apps/cli/src/shared/telemetry/__fixtures__/error-tags.txt.",
    ).toEqual({ added: [], removed: [] });
  });

  it("never lets two unexpectedly-different error classes share the same tag literal", async () => {
    const productionDeclarations = await collectProductionDeclarations();

    /**
     * Tags shared by more than one production class, keyed on the tag itself rather than
     * today's class names — keying on names would break the first time either class is
     * legitimately renamed. Add an entry only when two classes are meant to share a
     * fingerprint.
     */
    const allowedSharedTags: ReadonlySet<string> = new Set([
      // shared/functions/download.errors.ts and delete.errors.ts both
      // validate a `<slug>` argument the same way and intentionally report
      // it as the same fingerprint.
      "InvalidFunctionSlugError",
    ]);

    const filesByTag = new Map<string, Set<string>>();
    for (const declaration of productionDeclarations) {
      const files = filesByTag.get(declaration.tag) ?? new Set<string>();
      files.add(declaration.file);
      filesByTag.set(declaration.tag, files);
    }

    const collisions = [...filesByTag.entries()]
      .filter(([tag, files]) => files.size > 1 && !allowedSharedTags.has(tag))
      .map(([tag, files]) => `"${tag}" declared in: ${[...files].sort().join(", ")}`);

    expect(
      collisions,
      'More than one file passes the same string to Data.TaggedError("..."), and it is not in this ' +
        "test's `allowedSharedTags` allowlist. Since that string is the telemetry identity reported to " +
        "PostHog, an unreviewed collision makes two conceptually different errors indistinguishable in " +
        "error_fingerprint. Either give the new class its own tag literal, or -- if the collision is " +
        "intentional -- add the tag (not the class name) to `allowedSharedTags` with a comment " +
        "explaining why.",
    ).toEqual([]);
  });
});
