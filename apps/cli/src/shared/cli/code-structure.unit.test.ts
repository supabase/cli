import { BunServices } from "@effect/platform-bun";
import { describe, expect, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import { fileURLToPath } from "node:url";

import { CLI_CONFIG_FLAGS } from "../../config/cli-config-key-annotations.ts";
import {
  CliEnvNames,
  cliConfigRegistry,
  isCliConfigEnvName,
} from "../../config/cli-config-keys.ts";

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

const CONFIG_FOUNDATION_FILE = /^(?:config|shared\/config)\/cli-config-[^/]*\.ts$/;

const registryEnvNames: ReadonlySet<string> = new Set([
  ...cliConfigRegistry.keys.flatMap((key) => key.env),
  ...Object.values(CliEnvNames).map((entry) => entry.name),
]);

const isRegistryEnvName = (name: string): boolean =>
  registryEnvNames.has(name) ||
  isCliConfigEnvName(name) ||
  /^SUPABASE_REMOTES_[A-Z0-9_]+_PROJECT_ID$/.test(name);

const ENV_SOURCE = String.raw`(?:process\.env|Bun\.env|ambientEnvironment\(\)|\bprojectEnv\w*)`;
const ENV_READ_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(
    String.raw`${ENV_SOURCE}(?:\[\s*["'\`]([A-Z0-9_]+)["'\`]\s*\]|\.([A-Z][A-Z0-9_]*)\b)`,
    "g",
  ),
  /\bConfig\.\w+\(\s*["']([A-Z0-9_]+)["']/g,
  /\b(?:envOption|envValue)\(\s*["']([A-Z0-9_]+)["']/g,
];
const DYNAMIC_SUPABASE_ENV_READS: ReadonlyArray<RegExp> = [
  new RegExp(String.raw`${ENV_SOURCE}\[\s*` + "`" + String.raw`SUPABASE_\$\{`, "g"),
  /\b(?:Config\.\w+|envOption|envValue)\(\s*`SUPABASE_\$\{/g,
];

/** Registry env names read directly, plus dynamically built `SUPABASE_${...}` names. */
export function findRegistryEnvReads(source: string): Array<string> {
  const hits: Array<string> = [];
  for (const pattern of ENV_READ_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1] ?? match[2];
      if (name !== undefined && isRegistryEnvName(name)) hits.push(name);
    }
  }
  for (const pattern of DYNAMIC_SUPABASE_ENV_READS) {
    for (const match of source.matchAll(pattern)) hits.push(match[0]);
  }
  return hits;
}

const BANNED_IDENTIFIERS: ReadonlyArray<RegExp> = [
  ...[
    ["remote", "Wins"],
    ["make", "Remote", "Wins"],
    ["Remote", "Overridable", "Key"],
    ["remote", "Override", "Keys"],
    ["env", "Override"],
  ].map((parts) => new RegExp(String.raw`\b${parts.join("")}\w*`, "g")),
  /\bloadProjectEnv\b/g,
];

export function findBannedIdentifiers(source: string): Array<string> {
  return BANNED_IDENTIFIERS.flatMap((pattern) => Array.from(source.matchAll(pattern), (m) => m[0]));
}

const FLAG_INPUTS_CONSTRUCTION =
  /(?:Layer\.\w+|Effect\.provideService|Context\.\w+|Command\.provide\w*)\(\s*CliConfigFlagInputs\b|\bCliConfigFlagInputs\.of\(/g;

export function findFlagInputsConstruction(source: string): Array<string> {
  return Array.from(source.matchAll(FLAG_INPUTS_CONSTRUCTION), (m) => m[0]);
}

const declaredConfigFlagNames: ReadonlyArray<string> = Object.values(CLI_CONFIG_FLAGS).flatMap(
  (declaration) => declaration.names,
);

export function findRawConfigFlags(source: string): Array<string> {
  return declaredConfigFlagNames.flatMap((name) =>
    Array.from(
      source.matchAll(new RegExp(String.raw`\bFlag\.\w+\(\s*["']${name}["']`, "g")),
      (m) => m[0],
    ),
  );
}

const LOAD_PROJECT_ENVIRONMENT_IMPORT =
  /import\s+(?:type\s+)?\{[^}]*\bloadCliProjectEnvironment\b[^}]*\}\s*from\s*["']@supabase\/config[^"']*["']/g;

export function findLoadCliProjectEnvironmentImport(source: string): Array<string> {
  return Array.from(source.matchAll(LOAD_PROJECT_ENVIRONMENT_IMPORT), (m) => m[0]);
}

const allSpecifiers = (source: string): Array<string> =>
  Array.from(
    source.matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g),
    (match) => match[1]!,
  ).filter((specifier) => specifier.startsWith("."));

const isAnyTypeScript = (filePath: string): boolean => filePath.endsWith(".ts");

const scanSource = (
  files: ReadonlyArray<string>,
  rule: (relativePath: string, source: string) => ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const violations: Array<string> = [];
    for (const filePath of files) {
      const relativePath = path.relative(srcDir, filePath).split(path.sep).join("/");
      const source = yield* fs.readFileString(filePath);
      for (const hit of rule(relativePath, source)) violations.push(`${relativePath}: ${hit}`);
    }
    return violations;
  });

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

  it.effect("keeps registry env names behind the config foundation", () =>
    Effect.gen(function* () {
      const files = (yield* walk(srcDir)).filter(isSourceFile);
      const violations = yield* scanSource(files, (relativePath, source) =>
        CONFIG_FOUNDATION_FILE.test(relativePath) ? [] : findRegistryEnvReads(source),
      );
      expect(violations).toEqual([]);
    }),
  );

  it.effect("bans the legacy overlay identifiers", () =>
    Effect.gen(function* () {
      const files = (yield* walk(srcDir)).filter(isAnyTypeScript);
      const violations = yield* scanSource(files, (_, source) => findBannedIdentifiers(source));
      expect(violations).toEqual([]);
    }),
  );

  it.effect("keeps the config foundation independent from commands and command-internal", () =>
    Effect.gen(function* () {
      const { path, commandsDir } = yield* layout;
      const commandInternalDir = path.join(srcDir, "command-internal");
      const files = (yield* walk(srcDir)).filter(
        (filePath) =>
          isSourceFile(filePath) &&
          CONFIG_FOUNDATION_FILE.test(path.relative(srcDir, filePath).split(path.sep).join("/")),
      );
      const violations = yield* scanSource(files, (relativePath, source) =>
        allSpecifiers(source).filter((specifier) => {
          const resolved = resolveImport(path, path.join(srcDir, relativePath), specifier);
          return resolved.startsWith(commandsDir) || resolved.startsWith(commandInternalDir);
        }),
      );
      expect(violations).toEqual([]);
    }),
  );

  it.effect("constructs CliConfigFlagInputs only in cli-config-flags.ts", () =>
    Effect.gen(function* () {
      const files = (yield* walk(srcDir)).filter(isSourceFile);
      const violations = yield* scanSource(files, (relativePath, source) =>
        relativePath === "config/cli-config-flags.ts" ? [] : findFlagInputsConstruction(source),
      );
      expect(violations).toEqual([]);
    }),
  );

  it.effect("declares registry-backed flags with key.flag", () =>
    Effect.gen(function* () {
      const files = (yield* walk(srcDir)).filter(isSourceFile);
      const violations = yield* scanSource(files, (_, source) => findRawConfigFlags(source));
      expect(violations).toEqual([]);
    }),
  );

  it.effect("does not import loadCliProjectEnvironment from @supabase/config", () =>
    Effect.gen(function* () {
      const files = (yield* walk(srcDir)).filter(isAnyTypeScript);
      const violations = yield* scanSource(files, (_, source) =>
        findLoadCliProjectEnvironmentImport(source),
      );
      expect(violations).toEqual([]);
    }),
  );
});

describe("config precedence guard rules", () => {
  it("flags registry env reads in every read position", () => {
    const fixture = [
      'process.env["SUPABASE_DB_PASSWORD"]',
      "process.env.SUPABASE_API_PORT",
      'Bun.env["SUPABASE_PROJECT_ID"]',
      'Config.string("SUPABASE_DB_PORT")',
      'envOption("SUPABASE_AUTH_SITE_URL")',
      'envValue("SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET")',
      'ambientEnvironment()["SUPABASE_REMOTES_STAGING_PROJECT_ID"]',
      "ambientEnvironment().SUPABASE_DB_PORT",
      'projectEnv["SUPABASE_DB_PORT"]',
      "process.env[`SUPABASE_${name}`]",
      "envValue(`SUPABASE_${name}`)",
    ].join("\n");
    expect(findRegistryEnvReads(fixture)).toHaveLength(11);
  });

  it("ignores names outside the registry and non-read mentions", () => {
    const fixture =
      'process.env["SUPABASE_ACCESS_TOKEN"]; const label = "SUPABASE_DB_PORT"; `SUPABASE_${x}_KEY`;';
    expect(findRegistryEnvReads(fixture)).toEqual([]);
  });

  it("flags each banned identifier", () => {
    const names = [
      ["remote", "Wins"],
      ["make", "Remote", "Wins"],
      ["remote", "Override", "Keys"],
      ["env", "Override"],
      ["env", "Override", "Foo"],
      ["load", "Project", "Env"],
    ].map((parts) => parts.join(""));
    for (const name of names) {
      expect(findBannedIdentifiers(`const x = ${name}(y);`)).toEqual([name]);
    }
  });

  it("does not flag the supported env loader", () => {
    expect(findBannedIdentifiers("loadProjectEnvValues(fs, path, workdir)")).toEqual([]);
  });

  it("flags CliConfigFlagInputs construction", () => {
    expect(
      findFlagInputsConstruction("Layer.succeed(CliConfigFlagInputs, new Map())"),
    ).toHaveLength(1);
    expect(findFlagInputsConstruction("CliConfigFlagInputs.of(new Map())")).toHaveLength(1);
    expect(
      findFlagInputsConstruction("Effect.provideService(CliConfigFlagInputs, m)"),
    ).toHaveLength(1);
    expect(findFlagInputsConstruction("const inputs = yield* CliConfigFlagInputs;")).toEqual([]);
  });

  it("flags raw declarations of registry-backed flags", () => {
    for (const name of declaredConfigFlagNames) {
      expect(findRawConfigFlags(`Flag.string("${name}")`)).toHaveLength(1);
    }
    expect(findRawConfigFlags('Flag.string("project-id")')).toEqual([]);
  });

  it("flags loadCliProjectEnvironment imports from @supabase/config", () => {
    const loader = ["loadCli", "ProjectEnvironment"].join("");
    expect(
      findLoadCliProjectEnvironmentImport(`import { ${loader} } from "@supabase/config";`),
    ).toHaveLength(1);
    expect(
      findLoadCliProjectEnvironmentImport(
        `import {\n  type X,\n  ${loader},\n} from "@supabase/config/internal";`,
      ),
    ).toHaveLength(1);
    expect(
      findLoadCliProjectEnvironmentImport('import { other } from "@supabase/config";'),
    ).toEqual([]);
  });

  it("resolves static and dynamic relative specifiers", () => {
    expect(
      allSpecifiers('import a from "../command-internal/x.ts"; await import("./y.ts");'),
    ).toEqual(["../command-internal/x.ts", "./y.ts"]);
  });
});
