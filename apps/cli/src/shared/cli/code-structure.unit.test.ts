import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import type { PlatformError } from "effect/PlatformError";

interface StructureAnalysis {
  readonly indexFiles: ReadonlyArray<string>;
  readonly concernViolations: ReadonlyArray<string>;
  readonly docsViolations: ReadonlyArray<string>;
  readonly nextCommandViolations: ReadonlyArray<string>;
  readonly legacyCommandViolations: ReadonlyArray<string>;
  readonly dbBootstrapViolations: ReadonlyArray<string>;
  readonly shellViolations: ReadonlyArray<string>;
}

const analyzeStructure = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const srcDir = fileURLToPath(new URL("../..", import.meta.url));
  const nextDir = path.join(srcDir, "next");
  const legacyDir = path.join(srcDir, "legacy");
  const sharedDir = path.join(srcDir, "shared");
  const nextCommandsDir = path.join(nextDir, "commands");
  const legacyCommandsDir = path.join(legacyDir, "commands");
  const legacyDbBootstrapDir = path.join(legacyDir, "shared", "db-bootstrap");
  const nextCliDir = path.join(nextDir, "cli");
  const legacyCliDir = path.join(legacyDir, "cli");
  const nextDocsDir = path.join(nextDir, "docs");
  const concernSlices = [
    path.join(nextDir, "auth"),
    path.join(nextDir, "config"),
    path.join(sharedDir, "output"),
    path.join(sharedDir, "runtime"),
    path.join(sharedDir, "telemetry"),
  ];

  const walk = (dir: string): Effect.Effect<ReadonlyArray<string>, PlatformError> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(dir);
      const nested = yield* Effect.forEach(entries, (entry) => {
        const fullPath = path.join(dir, entry);
        return fs
          .stat(fullPath)
          .pipe(
            Effect.flatMap((stats) =>
              stats.type === "Directory" ? walk(fullPath) : Effect.succeed([fullPath]),
            ),
          );
      });
      return nested.flat();
    });

  const isSourceFile = (filePath: string) =>
    filePath.endsWith(".ts") &&
    !filePath.endsWith(".unit.test.ts") &&
    !filePath.endsWith(".integration.test.ts") &&
    !filePath.endsWith(".e2e.test.ts") &&
    !filePath.endsWith(".d.ts");

  const extractRelativeImports = (filePath: string) =>
    fs
      .readFileString(filePath, "utf8")
      .pipe(
        Effect.map((source) =>
          Array.from(source.matchAll(/from\s+["']([^"']+)["']/g), (match) => match[1]).filter(
            (specifier): specifier is string =>
              specifier !== undefined && specifier.startsWith("."),
          ),
        ),
      );

  const resolveImport = (filePath: string, specifier: string) =>
    path.normalize(path.resolve(path.dirname(filePath), specifier));

  const relativeImports = (
    files: ReadonlyArray<string>,
    violation: (filePath: string, specifier: string, resolved: string) => string | undefined,
  ) =>
    Effect.forEach(files, (filePath) =>
      extractRelativeImports(filePath).pipe(
        Effect.map((imports) =>
          imports
            .map((specifier) => violation(filePath, specifier, resolveImport(filePath, specifier)))
            .filter((value): value is string => value !== undefined),
        ),
      ),
    ).pipe(Effect.map((values) => values.flat()));

  const allSourceFiles = (dir: string) =>
    walk(dir).pipe(Effect.map((files) => files.filter(isSourceFile)));
  const concernFiles = yield* Effect.forEach(concernSlices, allSourceFiles).pipe(
    Effect.map((values) => values.flat()),
  );
  const concernViolations = yield* relativeImports(concernFiles, (filePath, specifier, resolved) =>
    resolved.startsWith(nextCommandsDir) ||
    resolved.startsWith(legacyCommandsDir) ||
    resolved.startsWith(nextCliDir) ||
    resolved.startsWith(legacyCliDir)
      ? `${path.relative(srcDir, filePath)} -> ${specifier}`
      : undefined,
  );

  const docsViolations = yield* relativeImports(
    yield* allSourceFiles(nextDocsDir),
    (filePath, specifier, resolved) =>
      resolved.startsWith(nextCliDir) ||
      resolved.startsWith(legacyCliDir) ||
      resolved.startsWith(nextCommandsDir) ||
      resolved.startsWith(legacyCommandsDir)
        ? `${path.relative(srcDir, filePath)} -> ${specifier}`
        : undefined,
  );

  const commandViolations = (
    commandsDir: string,
  ): Effect.Effect<ReadonlyArray<string>, PlatformError> =>
    Effect.gen(function* () {
      const files = yield* allSourceFiles(commandsDir);
      return yield* relativeImports(files, (filePath, specifier, resolved) => {
        if (!resolved.startsWith(commandsDir)) return undefined;
        const relativeFile = path.relative(commandsDir, filePath);
        const currentCommand = relativeFile.split(path.sep)[0];
        const relativeTarget = path.relative(commandsDir, resolved);
        const targetCommand = relativeTarget.split(path.sep)[0];
        return targetCommand !== currentCommand
          ? `${path.relative(srcDir, filePath)} -> ${specifier}`
          : undefined;
      });
    });

  const nextCommandViolations = yield* commandViolations(nextCommandsDir);
  const legacyCommandViolations = yield* commandViolations(legacyCommandsDir);
  const dbBootstrapViolations = yield* relativeImports(
    yield* allSourceFiles(legacyDbBootstrapDir),
    (filePath, specifier, resolved) =>
      resolved.startsWith(legacyCommandsDir)
        ? `${path.relative(srcDir, filePath)} -> ${specifier}`
        : undefined,
  );

  const shellViolations = yield* Effect.forEach(
    [
      [nextDir, legacyDir],
      [legacyDir, nextDir],
    ] as const,
    ([shellDir, otherShellDir]) =>
      Effect.gen(function* () {
        const files = yield* allSourceFiles(shellDir);
        return yield* relativeImports(files, (filePath, specifier, resolved) =>
          resolved.startsWith(otherShellDir)
            ? `${path.relative(srcDir, filePath)} -> ${specifier}`
            : undefined,
        );
      }),
  ).pipe(Effect.map((values) => values.flat()));

  return {
    indexFiles: (yield* walk(srcDir)).filter((filePath) => path.basename(filePath) === "index.ts"),
    concernViolations,
    docsViolations,
    nextCommandViolations,
    legacyCommandViolations,
    dbBootstrapViolations,
    shellViolations,
  } satisfies StructureAnalysis;
});

const runAnalysis = analyzeStructure.pipe(Effect.provide(BunServices.layer));

describe("code structure", () => {
  it.effect("does not keep barrel index.ts files under src", () =>
    Effect.map(runAnalysis, (analysis) => expect(analysis.indexFiles).toEqual([])),
  );

  it.effect("keeps concern slices independent from shell cli and commands", () =>
    Effect.map(runAnalysis, (analysis) => expect(analysis.concernViolations).toEqual([])),
  );

  it.effect("keeps next docs independent from cli and commands", () =>
    Effect.map(runAnalysis, (analysis) => expect(analysis.docsViolations).toEqual([])),
  );

  it.effect("prevents next commands from importing other next command internals", () =>
    Effect.map(runAnalysis, (analysis) => expect(analysis.nextCommandViolations).toEqual([])),
  );

  it.effect("prevents legacy commands from importing other legacy command internals", () =>
    Effect.map(runAnalysis, (analysis) => expect(analysis.legacyCommandViolations).toEqual([])),
  );

  it.effect("keeps legacy/shared/db-bootstrap independent from legacy commands", () =>
    Effect.map(runAnalysis, (analysis) => expect(analysis.dbBootstrapViolations).toEqual([])),
  );

  it.effect("prevents next and legacy from importing each other", () =>
    Effect.map(runAnalysis, (analysis) => expect(analysis.shellViolations).toEqual([])),
  );
});
