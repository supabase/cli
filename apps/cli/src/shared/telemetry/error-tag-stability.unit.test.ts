import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
 * This suite enumerates every production `Data.TaggedError("...")`
 * declaration reachable from `apps/cli/src` (including the multi-line form
 * the formatter produces for long class names), PLUS:
 *
 * - the tags `mintConfigTargetErrors` (`command-internal/project-target.ts`)
 *   computes via template interpolation (`` Data.TaggedError(`${prefix}...`)
 *   ``), which a source-text regex can never see. Those are collected at
 *   RUNTIME instead, by importing each known caller module and reading the
 *   real `_tag` off a constructed instance -- see
 *   {@link collectComputedTagDeclarations}.
 * - the external tags declared by `@supabase/config`
 *   (`packages/config/src/errors.ts`), which `externalActionabilityByTag` in
 *   `error-actionability.ts` also treats as telemetry identities.
 *
 * and compares the resulting set of tag literals against the committed
 * snapshot in `__fixtures__/error-tags.txt`.
 *
 * Known gap (deliberately not closed): the snapshot is a SET of tags, not an
 * owner-to-tag mapping, so it cannot detect two classes swapping tags with
 * each other in the same change (each tag still exists, just attached to the
 * other class). Recording an owner->tag mapping would close that gap, but at
 * the cost of failing on ordinary, safe class renames -- which is exactly
 * the false positive this suite exists to eliminate. That failure mode is
 * real but vanishingly unlikely (it requires two tags to swap in a single
 * commit and both survive review), so it is accepted rather than designed
 * around.
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
 * The production callers whose tags `mintConfigTargetErrors` computes via
 * template interpolation (`command-internal/project-target.ts`'s doc
 * comment). Paths are relative to `cliSrcDir`. Every exported class in these
 * modules -- minted or plain-literal alike -- is resolved at runtime instead
 * of by static regex, so this list is also the source of truth for which
 * files {@link collectStaticDeclarations} must skip to avoid double-counting.
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
 * Statically regexes every `Data.TaggedError("...")` string-literal
 * declaration out of the given production files. Deliberately skips
 * `COMPUTED_TAG_SOURCE_FILES` -- their tags (both minted and plain-literal)
 * come from {@link collectComputedTagDeclarations} instead, so a file never
 * contributes the same declaration through both paths.
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
 * Runtime half of the computed-tag guard: imports each
 * `COMPUTED_TAG_SOURCE_FILES` module and walks `Object.entries` over its
 * exports, constructing anything that looks like a `Data.TaggedError` class
 * to read its real, fully-interpolated `_tag` off the instance. A source-text
 * regex cannot see `` Data.TaggedError(`${prefix}BranchNotFoundError`) `` --
 * this can, because it runs the interpolation instead of parsing around it.
 *
 * Every export in these modules is a `Data.TaggedError`-derived class taking
 * a plain args object (see each file), so `new Export({})` is safe: the
 * generated base constructor never validates its shape at runtime, it only
 * assigns whatever properties are present.
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

/** Single comparator used for both the committed fixture and the live scan, so a
 * `localeCompare`-vs-default-sort mismatch can never make an order-sensitive
 * comparison lie (see `readSnapshotTags`/regeneration below). */
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
     * Tags that more than one production class intentionally shares. Keyed
     * on the TAG -- the actual telemetry identity -- never on today's class
     * names: this suite's whole premise is that class names are free to
     * rename, so gating "is this collision fine" on the CURRENT names would
     * itself break the very first time someone does a legitimate rename of
     * one of the two classes below while correctly preserving the tag. Add
     * an entry here only when two classes are deliberately meant to report
     * as the same fingerprint.
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
