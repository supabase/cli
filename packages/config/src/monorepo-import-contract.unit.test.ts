import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Option, Path, type PlatformError } from "effect";
import { fileURLToPath } from "node:url";

function runPlatform<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
}

const { dirname, join, sep } = await runPlatform(Effect.service(Path.Path));

// Enforces the import rules in `packages/config/AGENTS.md`'s "Monorepo import rule". Forbidden
// specifiers are built by concatenation so this file's own source can't self-match the scan.
const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(srcDir, "..", "..", "..");

const configPackageName = ["@supabase", "config"].join("/");
const forbiddenIoSpecifier = `${configPackageName}/io`;
const forbiddenDeepImportPrefix = `${configPackageName}/src/`;
const internalSpecifier = `${configPackageName}/internal`;
const allowedInternalConsumerPrefix = `${join(repoRoot, "apps", "cli")}${sep}`;

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", ".repos"]);
const thisPackageDir = join(srcDir, "..");

/* Entries deleted mid-walk by concurrently running tests are skipped, not failures. */
const orNoneIfNotFound = <A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );

const collectTsFiles: (
  dir: string,
  into: string[],
) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> = Effect.fnUntraced(
  function* (dir, into) {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(dir);
    for (const name of names) {
      const fullPath = join(dir, name);
      /* Matches `Dirent` semantics: a symlink is neither a directory nor a file. */
      if (Exit.isSuccess(yield* Effect.exit(fs.readLink(fullPath)))) {
        continue;
      }
      const stat = yield* orNoneIfNotFound(fs.stat(fullPath));
      if (Option.isNone(stat)) {
        continue;
      }
      const info = stat.value;

      if (info.type === "Directory") {
        if (EXCLUDED_DIR_NAMES.has(name) || fullPath === thisPackageDir) {
          continue;
        }
        yield* orNoneIfNotFound(collectTsFiles(fullPath, into));
      } else if (info.type === "File" && (name.endsWith(".ts") || name.endsWith(".tsx"))) {
        into.push(fullPath);
      }
    }
  },
);

const findViolations = Effect.fnUntraced(function* (forbiddenSpecifier: string) {
  const fs = yield* FileSystem.FileSystem;
  const files: string[] = [];
  for (const workspaceRoot of ["apps", "packages"]) {
    yield* collectTsFiles(join(repoRoot, workspaceRoot), files);
  }

  const violations: string[] = [];
  for (const file of files) {
    const source = yield* orNoneIfNotFound(fs.readFileString(file));
    if (Option.isSome(source) && source.value.includes(forbiddenSpecifier)) {
      violations.push(file);
    }
  }
  return violations.sort();
});

describe("monorepo import contract for @supabase/config", () => {
  test("no file outside this package imports the @supabase/config/io entrypoint", () =>
    runPlatform(
      Effect.gen(function* () {
        expect(yield* findViolations(forbiddenIoSpecifier)).toEqual([]);
      }),
    ));

  test("no file outside this package deep-imports @supabase/config/src/*", () =>
    runPlatform(
      Effect.gen(function* () {
        expect(yield* findViolations(forbiddenDeepImportPrefix)).toEqual([]);
      }),
    ));

  test("every @supabase/config/internal import outside this package is under apps/cli/", () =>
    runPlatform(
      Effect.gen(function* () {
        const violations = (yield* findViolations(internalSpecifier)).filter(
          (file) => !file.startsWith(allowedInternalConsumerPrefix),
        );
        expect(violations).toEqual([]);
      }),
    ));
});
