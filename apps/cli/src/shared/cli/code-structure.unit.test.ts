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

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const NAME_LITERAL = /(["'`])(SUPABASE_[A-Z0-9_]+)\1/g;
const NAME_PROPERTY = /\.(SUPABASE_[A-Z0-9_]+)\b/g;
const NAME_DESTRUCTURE = /\{[^{}]*?\b(SUPABASE_[A-Z0-9_]+)\b[^{}]*\}\s*=[^=>]/g;
const DYNAMIC_SUPABASE_READS: ReadonlyArray<RegExp> = [
  /\[\s*`SUPABASE_\$\{/g,
  /\b(?:Config\.\w+|envOption|envValue|envOrDefault)\(\s*`SUPABASE_\$\{/g,
];

/** Registry env names written as a literal, property or destructured binding, whatever reads them. */
export function findRegistryEnvReads(source: string): Array<string> {
  const code = stripComments(source);
  const hits: Array<string> = [];
  for (const [pattern, group] of [
    [NAME_LITERAL, 2],
    [NAME_PROPERTY, 1],
    [NAME_DESTRUCTURE, 1],
  ] as const) {
    for (const match of code.matchAll(pattern)) {
      const name = match[group];
      if (name !== undefined && isRegistryEnvName(name)) hits.push(name);
    }
  }
  for (const pattern of DYNAMIC_SUPABASE_READS) {
    for (const match of code.matchAll(pattern)) hits.push(match[0]);
  }
  return hits;
}

const AMBIENT_ENV_ESCAPES: ReadonlyArray<RegExp> = [
  /\b(?:process|Bun)\s*\.\s*env\b/g,
  /\b(?:process|Bun)\s*\[\s*["'`]env["'`]\s*\]/g,
  /\b(?:globalThis|global)\s*(?:\.\s*(?:process|Bun)\b|\[\s*["'`](?:process|Bun)["'`]\s*\])/g,
  /\{[^{}]*\benv\b[^{}]*\}\s*=\s*(?:globalThis\.)?(?:process|Bun)\b/g,
  /=\s*(?:globalThis\.)?(?:process|Bun)\s*[;,)\n]/g,
  /import\s+(?!process\b)\w+\s*(?:,[^;]*)?from\s*["'](?:node:)?process["']/g,
  /import\s*\*\s*as\s*\w+\s*from\s*["'](?:node:)?process["']/g,
  /import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["'](?:node:process|process|bun)["']/g,
  /\brequire\(\s*["'](?:node:)?process["']\s*\)/g,
];

/** Ways to reach the process environment other than `CliConfigValues`. */
export function findAmbientEnvEscapes(source: string): Array<string> {
  const code = stripComments(source);
  return AMBIENT_ENV_ESCAPES.flatMap((pattern) => Array.from(code.matchAll(pattern), (m) => m[0]));
}

/** Files that name a registry env variable without reading it, with the reason. */
const REGISTRY_NAME_EXEMPT: Readonly<Record<string, string>> = {
  "shared/telemetry/event-catalog.ts": "lists the variables whose presence the telemetry reports",
};

const AMBIENT_ENV_EXEMPT: ReadonlyArray<RegExp> = [
  /^shared\/cli\/bin\.ts$/,
  /^shared\/compute\/stacks\//,
];

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

const CONFIG_LOADERS = [
  "loadCliConfig",
  "resolveCliConfigValue",
  "resolveCliConfigSubtree",
  "decodeCliConfigDocumentForValidationEffect",
  "loadCliProjectEnvironment",
];

const COMPAT_OPTION = ["cli", "Compat"].join("");
const WHOLE_CONFIG_IMPORT =
  /\b(?:(?:import|export)\s+(?:type\s+)?\*\s*(?:as\s+\w+\s*)?from\s*|import\s*\(\s*)["']@supabase\/config(?:\/effect|\/internal)?["']/g;

/** Imports of the package loaders that resolve config outside the `CliConfigValues` resolved config. */
export function findConfigLoaderImports(
  source: string,
  loaders: ReadonlyArray<string> = CONFIG_LOADERS,
): Array<string> {
  const pattern = new RegExp(
    String.raw`import\s+(?:type\s+)?\{[^}]*\b(?:${loaders.join("|")})\b[^}]*\}\s*from\s*["']@supabase/config[^"']*["']`,
    "g",
  );
  return Array.from(stripComments(source).matchAll(pattern), (m) => m[0]);
}

/** Every way to reach the package loaders: named imports, whole-module imports, or the compat option. */
function findConfigLoaderBypasses(source: string): Array<string> {
  const code = stripComments(source);
  return [
    ...findConfigLoaderImports(source),
    ...Array.from(code.matchAll(WHOLE_CONFIG_IMPORT), (m) => m[0]),
    ...(code.includes(COMPAT_OPTION) ? [COMPAT_OPTION] : []),
  ];
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
        CONFIG_FOUNDATION_FILE.test(relativePath) || relativePath in REGISTRY_NAME_EXEMPT
          ? []
          : findRegistryEnvReads(source),
      );
      expect(violations).toEqual([]);
    }),
  );

  it.effect("keeps process environment access behind the config foundation", () =>
    Effect.gen(function* () {
      const files = (yield* walk(srcDir)).filter(isSourceFile);
      const violations = yield* scanSource(files, (relativePath, source) =>
        CONFIG_FOUNDATION_FILE.test(relativePath) ||
        AMBIENT_ENV_EXEMPT.some((exempt) => exempt.test(relativePath))
          ? []
          : findAmbientEnvEscapes(source),
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

  it.effect("imports the package config loaders only in the config foundation", () =>
    Effect.gen(function* () {
      const files = (yield* walk(srcDir)).filter(isSourceFile);
      const violations = yield* scanSource(files, (relativePath, source) =>
        CONFIG_FOUNDATION_FILE.test(relativePath) ? [] : findConfigLoaderBypasses(source),
      );
      expect(violations).toEqual([]);
    }),
  );

  it.effect("never imports loadCliProjectEnvironment, even in tests", () =>
    Effect.gen(function* () {
      const files = (yield* walk(srcDir)).filter(isAnyTypeScript);
      const violations = yield* scanSource(files, (_, source) =>
        findConfigLoaderImports(source, ["loadCliProjectEnvironment"]),
      );
      expect(violations).toEqual([]);
    }),
  );
});

describe("config precedence guard rules", () => {
  it("flags registry env names in every read position", () => {
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
      'supabaseEnvBool("SUPABASE_DB_SEED_ENABLED")',
      'supabaseEnvStringWithProjectFallback("SUPABASE_DB_PORT", env)',
      'resolvedConfig.sources.shell("SUPABASE_DB_PORT")',
      'lookupCliConfigEnv(resolvedConfig.sources, "SUPABASE_DB_PORT")',
      'values["SUPABASE_DB_PORT"]',
      'toml.projectEnv["SUPABASE_DB_PORT"]',
      "const { SUPABASE_DB_PORT } = env;",
      "process.env[`SUPABASE_${name}`]",
      "envValue(`SUPABASE_${name}`)",
    ].join("\n");
    expect(findRegistryEnvReads(fixture)).toHaveLength(18);
  });

  it("ignores names outside the registry, comments and prose", () => {
    const fixture = [
      'process.env["SUPABASE_ACCESS_TOKEN"];',
      'const label = "SUPABASE_DB_PORT is set"; `SUPABASE_${x}_KEY`;',
      '// values["SUPABASE_DB_PORT"]',
      "/* process.env.SUPABASE_DB_PORT */",
    ].join("\n");
    expect(findRegistryEnvReads(fixture)).toEqual([]);
  });

  it("flags every way to reach the process environment", () => {
    const fixture = [
      'import { env } from "node:process";',
      'import * as proc from "node:process";',
      'import alias from "node:process";',
      'import { env as bunEnv } from "bun";',
      "const { env: e2 } = process;",
      'const e3 = globalThis.process.env["X"];',
      'const e4 = process["env"]["X"];',
      "const e5 = process.env.X;",
      "const e6 = Bun.env.X;",
      "const p = process;",
      'const e7 = require("node:process");',
    ];
    for (const line of fixture) expect(findAmbientEnvEscapes(line), line).not.toEqual([]);
  });

  it("allows ordinary process use", () => {
    const fixture = [
      'import process from "node:process";',
      "process.stderr.write(text); process.exit(1); const cwd = process.cwd();",
      "// process.env.X",
    ].join("\n");
    expect(findAmbientEnvEscapes(fixture)).toEqual([]);
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

  it("flags package config loader imports", () => {
    for (const loader of CONFIG_LOADERS) {
      expect(findConfigLoaderImports(`import { ${loader} } from "@supabase/config";`)).toHaveLength(
        1,
      );
      expect(
        findConfigLoaderImports(
          `import {\n  type X,\n  ${loader},\n} from "@supabase/config/internal";`,
        ),
      ).toHaveLength(1);
    }
    expect(findConfigLoaderImports('import { other } from "@supabase/config";')).toEqual([]);
  });

  it("flags whole-module imports of the config package and the compat option", () => {
    expect(
      findConfigLoaderBypasses('import * as config from "@supabase/config/internal";'),
    ).toHaveLength(1);
    expect(findConfigLoaderBypasses('const c = await import("@supabase/config");')).toHaveLength(1);
    expect(findConfigLoaderBypasses(`load(cwd, { ${COMPAT_OPTION}: true });`)).toHaveLength(1);
    expect(findConfigLoaderBypasses('import { other } from "@supabase/config";')).toEqual([]);
  });

  it("resolves static and dynamic relative specifiers", () => {
    expect(
      allSpecifiers('import a from "../command-internal/x.ts"; await import("./y.ts");'),
    ).toEqual(["../command-internal/x.ts", "./y.ts"]);
  });
});
