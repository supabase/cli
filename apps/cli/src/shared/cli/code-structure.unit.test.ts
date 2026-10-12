import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import { fileURLToPath } from "node:url";

const cliConfigLoadFile = "command-internal/cli-config-load.ts";
const strictPublicLoaderAllowList = new Set(["commands/experimental/compute/compute.shared.ts"]);

const compatOption = ["cli", "Compat"].join("");
const internalLoaderNames =
  /\b(?:loadCliConfig|resolveCliConfigValue|resolveCliConfigSubtree|decodeCliConfigDocumentForValidationEffect)\b/;
const publicLoaderNames = /\b(?:loadCliConfig|resolveCliConfigValue|resolveCliConfigSubtree)\b/;
const namedConfigImport =
  /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](@supabase\/config(?:\/effect|\/internal)?)["']/g;
const wholeConfigImport =
  /\b(?:(?:import|export)\s+(?:type\s+)?\*\s*(?:as\s+\w+\s*)?from\s*|import\s*\(\s*)["'](@supabase\/config(?:\/effect|\/internal)?)["']/g;

const findConfigLoadingViolations = (relativeFile: string, source: string): Array<string> => {
  const violations: Array<string> = [];
  if (source.includes(compatOption)) {
    violations.push(`${relativeFile} mentions ${compatOption}`);
  }
  for (const [, specifier] of source.matchAll(wholeConfigImport)) {
    violations.push(
      `${relativeFile} uses a namespace, star, or dynamic import of ${specifier}; import named symbols instead`,
    );
  }
  for (const match of source.matchAll(namedConfigImport)) {
    const [statement, names, specifier] = [match[0], match[1]!, match[2]!];
    const isInternal = specifier === "@supabase/config/internal";
    if (isInternal ? internalLoaderNames.test(names) : publicLoaderNames.test(names)) {
      if (!isInternal && strictPublicLoaderAllowList.has(relativeFile)) continue;
      violations.push(
        `${relativeFile} imports a config loader from ${specifier} (\`${statement.replace(/\s+/g, " ")}\`); use ${cliConfigLoadFile}`,
      );
    }
  }
  return violations;
};

const srcDir = fileURLToPath(new URL("../..", import.meta.url));

const layout = Effect.gen(function* () {
  const path = yield* Path.Path;
  const sharedDir = path.join(srcDir, "shared");
  return {
    path,
    commandsDir: path.join(srcDir, "commands"),
    dbBootstrapDir: path.join(srcDir, "command-internal", "db-bootstrap"),
    cliDir: path.join(srcDir, "cli"),
    concernSlices: [
      path.join(sharedDir, "auth"),
      path.join(sharedDir, "config"),
      path.join(sharedDir, "output"),
      path.join(sharedDir, "runtime"),
      path.join(sharedDir, "telemetry"),
    ],
  };
});

const walk = (
  dir: string,
): Effect.Effect<Array<string>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(dir);
    const nested = yield* Effect.forEach(entries, (entry) => {
      if (entry === "__fixtures__") return Effect.succeed([]);
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

const extractRelativeImports = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(filePath);
    const imports = Array.from(source.matchAll(/from\s+["']([^"']+)["']/g), (match) => match[1]!);
    return imports.filter((specifier) => specifier.startsWith("."));
  });

const resolveImport = (path: Path.Path, filePath: string, specifier: string): string =>
  path.normalize(path.resolve(path.dirname(filePath), specifier));

function isSourceFile(filePath: string): boolean {
  return (
    filePath.endsWith(".ts") &&
    !filePath.endsWith(".unit.test.ts") &&
    !filePath.endsWith(".integration.test.ts") &&
    !filePath.endsWith(".e2e.test.ts") &&
    !filePath.endsWith(".d.ts")
  );
}

layer(BunServices.layer)("code structure", (it) => {
  it.effect("does not keep barrel index.ts files under src", () =>
    Effect.gen(function* () {
      const { path } = yield* layout;
      const indexFiles = (yield* walk(srcDir)).filter(
        (filePath) => path.basename(filePath) === "index.ts",
      );
      expect(indexFiles).toEqual([]);
    }),
  );

  it.effect("keeps concern slices independent from shell cli and commands", () =>
    Effect.gen(function* () {
      const { path, commandsDir, cliDir, concernSlices } = yield* layout;
      const violations: Array<string> = [];

      for (const sliceDir of concernSlices) {
        for (const filePath of (yield* walk(sliceDir)).filter(isSourceFile)) {
          for (const specifier of yield* extractRelativeImports(filePath)) {
            const resolved = resolveImport(path, filePath, specifier);
            if (resolved.startsWith(commandsDir) || resolved.startsWith(cliDir)) {
              violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
            }
          }
        }
      }

      expect(violations).toEqual([]);
    }),
  );

  it.effect("prevents commands from importing other command internals", () =>
    Effect.gen(function* () {
      const { path, commandsDir } = yield* layout;
      const violations: Array<string> = [];

      for (const filePath of (yield* walk(commandsDir)).filter(isSourceFile)) {
        const relativeFile = path.relative(commandsDir, filePath);
        const currentCommand = relativeFile.split(path.sep)[0];
        for (const specifier of yield* extractRelativeImports(filePath)) {
          const resolved = resolveImport(path, filePath, specifier);
          if (!resolved.startsWith(commandsDir)) {
            continue;
          }

          const relativeTarget = path.relative(commandsDir, resolved);
          const targetCommand = relativeTarget.split(path.sep)[0];
          if (targetCommand !== currentCommand) {
            violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
          }
        }
      }

      expect(violations).toEqual([]);
    }),
  );

  it.effect("keeps command-internal/db-bootstrap independent from commands", () =>
    Effect.gen(function* () {
      const { path, commandsDir, dbBootstrapDir } = yield* layout;
      const violations: Array<string> = [];

      for (const filePath of (yield* walk(dbBootstrapDir)).filter(isSourceFile)) {
        for (const specifier of yield* extractRelativeImports(filePath)) {
          const resolved = resolveImport(path, filePath, specifier);
          if (resolved.startsWith(commandsDir)) {
            violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
          }
        }
      }

      expect(violations).toEqual([]);
    }),
  );

  it.effect("routes CLI config loading through the single cli-config-load wrapper", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { path } = yield* layout;
      const violations: Array<string> = [];

      for (const filePath of (yield* walk(srcDir)).filter((file) => file.endsWith(".ts"))) {
        const relativeFile = path.relative(srcDir, filePath).split(path.sep).join("/");
        if (relativeFile === cliConfigLoadFile) continue;
        violations.push(
          ...findConfigLoadingViolations(relativeFile, yield* fs.readFileString(filePath)),
        );
      }

      expect(violations).toEqual([]);
    }),
  );
});
