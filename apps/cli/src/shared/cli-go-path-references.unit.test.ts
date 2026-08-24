import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import type { PlatformError } from "effect/PlatformError";

interface Reference {
  readonly sourceFile: string;
  readonly literal: string;
  readonly resolved: string;
}

const findCliGoReferences = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const scanDirs = [path.join(repoRoot, "apps/cli/src"), path.join(repoRoot, "apps/cli/scripts")];
  const thisFile = fileURLToPath(import.meta.url);
  const pattern = /new\s+URL\(\s*["'`]([^"'`]*cli-go[^"'`]*)["'`]\s*,\s*import\.meta\.url\s*\)/g;

  const walk = (dir: string): Effect.Effect<ReadonlyArray<string>, PlatformError> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(dir);
      const nested = yield* Effect.forEach(entries, (entry) => {
        const fullPath = path.join(dir, entry);
        return fs
          .stat(fullPath)
          .pipe(
            Effect.flatMap((stats) =>
              stats.type === "Directory"
                ? walk(fullPath)
                : fullPath.endsWith(".ts")
                  ? Effect.succeed([fullPath])
                  : Effect.succeed([]),
            ),
          );
      });
      return nested.flat();
    });

  const references: Array<Reference> = [];
  for (const dir of scanDirs) {
    const files = yield* walk(dir);
    for (const sourceFile of files) {
      if (sourceFile === thisFile) continue;
      const source = yield* fs.readFileString(sourceFile, "utf8");
      for (const match of source.matchAll(pattern)) {
        const literal = match[1];
        if (literal === undefined) continue;
        const resolved = literal.endsWith("/")
          ? `${path.resolve(path.dirname(sourceFile), literal)}/`
          : path.resolve(path.dirname(sourceFile), literal);
        references.push({ sourceFile, literal, resolved });
      }
    }
  }
  return { references, repoRoot, fs };
});

describe("apps/cli-go path references", () => {
  it.effect("every cli-go URL literal resolves to a path that still exists", () =>
    Effect.gen(function* () {
      const { references, repoRoot, fs } = yield* findCliGoReferences;
      const path = yield* Path.Path;
      expect(references.length).toBeGreaterThan(0);
      const missing = yield* Effect.forEach(
        references,
        (reference) =>
          fs
            .exists(reference.resolved.replace(/\/$/, ""))
            .pipe(
              Effect.map((exists) =>
                exists
                  ? undefined
                  : `${path.relative(repoRoot, reference.sourceFile)}: "${reference.literal}"`,
              ),
            ),
        { discard: false },
      );
      expect(missing.filter((value): value is string => value !== undefined)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
