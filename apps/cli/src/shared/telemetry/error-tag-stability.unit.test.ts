import { BunServices } from "@effect/platform-bun";
import { beforeAll, describe, expect, it } from "@effect/vitest";
import { Config, Effect, FileSystem, Option, Path, PlatformError } from "effect";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Guards the telemetry identity of every CLI error: the string passed to
 * `Data.TaggedError("...")` or `Schema.TaggedError` becomes `error_fingerprint` on the `cli_command_executed` event, so
 * changing it (not renaming the class) silently splits one error's history into two
 * fingerprints, undetected until dashboards look wrong.
 *
 * Enumerates every production tagged-error tag under `apps/cli/src` and
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
const externalConfigSrcDir = fileURLToPath(
  new URL("../../../../../packages/config/src", import.meta.url),
);
const fixturePath = fileURLToPath(new URL("./__fixtures__/error-tags.txt", import.meta.url));

// Matches `Data.TaggedError("…")` and `Schema.TaggedError<Self>()("…", …)`, inline or
// formatter-wrapped with the string literal on its own line.
const TAGGED_ERROR_PATTERN =
  /class\s+(\w+)\s+extends\s+(?:Data\.TaggedError|Schema\.TaggedError<\w+>\(\))\(\s*["']([^"']+)["']/g;

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

const walk = (
  dir: string,
): Effect.Effect<Array<string>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(dir);
    const nested = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        if (entry === "__fixtures__") return [];
        const fullPath = path.join(dir, entry);
        const stats = yield* fs.stat(fullPath);
        if (stats.type === "Directory") return yield* walk(fullPath);
        return fullPath.endsWith(".ts") && !fullPath.endsWith(".d.ts") ? [fullPath] : [];
      }),
    );
    return nested.flat();
  });

function isProductionSourceFile(filePath: string): boolean {
  return !TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

/**
 * Statically regexes every `Data.TaggedError("...")` string-literal declaration out of the
 * given production files, skipping `COMPUTED_TAG_SOURCE_FILES` (those come from
 * {@link collectComputedTagDeclarations} instead) so a file never contributes twice.
 */
const collectStaticDeclarations = (filePaths: ReadonlyArray<string>, rootDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const declarations: Array<TaggedErrorDeclaration> = [];
    for (const filePath of filePaths) {
      const relativeToRoot = path.relative(rootDir, filePath);
      if (rootDir === cliSrcDir && computedTagSourceFileSet.has(relativeToRoot)) continue;
      const source = yield* fs.readFileString(filePath);
      for (const match of source.matchAll(TAGGED_ERROR_PATTERN)) {
        declarations.push({
          className: match[1]!,
          tag: match[2]!,
          file: path.relative(repoRoot, filePath),
        });
      }
    }
    return declarations;
  });

/**
 * Runtime half of the computed-tag guard: imports each `COMPUTED_TAG_SOURCE_FILES` module,
 * constructs every exported class, and reads its real, fully-interpolated `_tag` off the
 * instance — a source-text regex can't see `` Data.TaggedError(`${prefix}...`) ``.
 *
 * `new Export({})` is safe because every export here is a `Data.TaggedError`-derived class
 * whose generated constructor assigns whatever properties are present without validating them.
 */
const collectComputedTagDeclarations = Effect.gen(function* () {
  const path = yield* Path.Path;
  const declarations: Array<TaggedErrorDeclaration> = [];
  for (const relativeFile of COMPUTED_TAG_SOURCE_FILES) {
    const moduleUrl = pathToFileURL(path.join(cliSrcDir, relativeFile)).href;
    const module: Record<string, unknown> = yield* Effect.tryPromise(() => import(moduleUrl));
    for (const [exportName, exportValue] of Object.entries(module)) {
      if (typeof exportValue !== "function") continue;
      const constructed = yield* Effect.try(() => {
        const Ctor = exportValue as new (args: Record<string, unknown>) => { _tag?: unknown };
        return new Ctor({})._tag;
      }).pipe(Effect.option);
      if (Option.isNone(constructed)) continue; // Not a constructible Data.TaggedError-shaped export.
      const tag = constructed.value;
      if (typeof tag !== "string") continue;
      declarations.push({ className: exportName, tag, file: `apps/cli/src/${relativeFile}` });
    }
  }
  return declarations;
});

/** Shared comparator for the fixture and the live scan, so a `localeCompare`-vs-default-sort
 * mismatch can't make the comparison lie. */
function compareTags(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const readSnapshotTags = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.readFileString(fixturePath)).split(/\r?\n/).filter((line) => line.length > 0);
});

/** Every production `Data.TaggedError` declaration, static and computed alike. */
const collectProductionDeclarations = Effect.gen(function* () {
  const cliFiles = (yield* walk(cliSrcDir)).filter(isProductionSourceFile);
  const externalFiles = (yield* walk(externalConfigSrcDir)).filter(isProductionSourceFile);
  const staticDeclarations = [
    ...(yield* collectStaticDeclarations(cliFiles, cliSrcDir)),
    ...(yield* collectStaticDeclarations(externalFiles, externalConfigSrcDir)),
  ];
  const computedDeclarations = yield* collectComputedTagDeclarations;
  return [...staticDeclarations, ...computedDeclarations];
});

/**
 * Regenerates `__fixtures__/error-tags.txt` from the current, live tag set.
 * Run with:
 *
 *   UPDATE_ERROR_TAGS_FIXTURE=1 bun --bun vitest run --project unit -t "error tag stability"
 *
 * Only ever do this after confirming the `added`/`removed` diff below is an
 * intentional, reviewed identity change -- not an accidental rename.
 */
const writeFixture = (tags: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sorted = [...tags].sort(compareTags);
    yield* fs.writeFileString(fixturePath, sorted.map((tag) => `${tag}\n`).join(""));
  });

describe("error tag stability", () => {
  let productionDeclarations: Array<TaggedErrorDeclaration>;

  beforeAll(() =>
    Effect.runPromise(collectProductionDeclarations.pipe(Effect.provide(BunServices.layer))).then(
      (declarations) => {
        productionDeclarations = declarations;
      },
    ),
  );

  it.live("keeps every Data.TaggedError tag literal identical to the committed snapshot", () =>
    Effect.gen(function* () {
      const currentTagSet = new Set(productionDeclarations.map((declaration) => declaration.tag));

      const updateFixture = yield* Config.option(Config.String("UPDATE_ERROR_TAGS_FIXTURE"));
      if (Option.isSome(updateFixture) && updateFixture.value === "1") {
        yield* writeFixture(currentTagSet);
      }

      const currentTags = [...currentTagSet].sort(compareTags);
      const snapshotTags = yield* readSnapshotTags;

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
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it("never lets two unexpectedly-different error classes share the same tag literal", () => {
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
