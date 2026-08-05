import type { LoadedProjectConfig, ProjectEnvironment } from "@supabase/config";
import type { DatabaseBootstrapConfig, DatabaseSeedFile } from "@supabase/stack/effect";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { glob, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { invalidLocalStackConfig, LocalStackConfigError } from "./core-stack-config.ts";

const GO_BOOLEAN_VALUES: Readonly<Record<string, boolean>> = {
  "1": true,
  t: true,
  T: true,
  TRUE: true,
  true: true,
  True: true,
  "0": false,
  f: false,
  F: false,
  FALSE: false,
  false: false,
  False: false,
};

const migrationFilePattern = /^([0-9]+)_(.*)\.sql$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedValue(
  root: Readonly<Record<string, unknown>> | undefined,
  path: ReadonlyArray<string>,
): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function remoteDefines(loaded: LoadedProjectConfig, path: ReadonlyArray<string>): boolean {
  if (loaded.appliedRemote === undefined || loaded.document === undefined) return false;
  const remotes = nestedValue(loaded.document, ["remotes"]);
  if (!isRecord(remotes)) return false;
  const remote = remotes[loaded.appliedRemote];
  return isRecord(remote) && nestedValue(remote, path) !== undefined;
}

function environmentOverride(
  name: string,
  environment: ProjectEnvironment | null,
): string | undefined {
  const value = environment?.values[name];
  if (value === undefined || value.length === 0) return undefined;
  const match = /^env\(([^)]+)\)$/.exec(value);
  if (match === null) return value;
  const referencedName = match[1];
  if (referencedName === undefined) return value;
  const referenced = environment?.values[referencedName];
  return referenced === undefined || referenced.length === 0 ? value : referenced;
}

function resolveBoolean(input: {
  readonly loaded: LoadedProjectConfig;
  readonly environment: ProjectEnvironment | null;
  readonly path: ReadonlyArray<string>;
  readonly envName: string;
  readonly configured: boolean;
}): boolean {
  const override = remoteDefines(input.loaded, input.path)
    ? undefined
    : environmentOverride(input.envName, input.environment);
  if (override === undefined) return input.configured;
  const resolved = GO_BOOLEAN_VALUES[override];
  if (resolved === undefined) {
    throw invalidLocalStackConfig(
      input.path.join("."),
      "Use a Go-compatible boolean such as true, false, 1, or 0.",
    );
  }
  return resolved;
}

function resolveList(input: {
  readonly loaded: LoadedProjectConfig;
  readonly environment: ProjectEnvironment | null;
  readonly path: ReadonlyArray<string>;
  readonly envName: string;
  readonly configured: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const override = remoteDefines(input.loaded, input.path)
    ? undefined
    : environmentOverride(input.envName, input.environment);
  return override === undefined ? input.configured : override.split(",");
}

function rawDefines(loaded: LoadedProjectConfig, path: ReadonlyArray<string>): boolean {
  return nestedValue(loaded.document, path) !== undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return false;
    throw cause;
  }
}

async function sqlFilesInDirectory(path: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sqlFilesInDirectory(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".sql")) {
      files.push(entryPath);
    }
  }
  return files;
}

async function expandSqlPatterns(input: {
  readonly patterns: ReadonlyArray<string>;
  readonly configDir: string;
}): Promise<{ readonly files: ReadonlyArray<string>; readonly hasUnmatchedPattern: boolean }> {
  const files: string[] = [];
  const seen = new Set<string>();
  let hasUnmatchedPattern = false;

  for (const pattern of input.patterns) {
    const absolutePattern = isAbsolute(pattern) ? pattern : join(input.configDir, pattern);
    let matches: ReadonlyArray<string>;
    try {
      matches = /[*?[]/.test(absolutePattern)
        ? await (async () => {
            const root = parse(absolutePattern).root;
            const patternFromRoot = relative(root, absolutePattern).split(sep).join("/");
            return (await Array.fromAsync(glob(patternFromRoot, { cwd: root })))
              .map((match) => (isAbsolute(match) ? match : join(root, match)))
              .sort();
          })()
        : (await exists(absolutePattern))
          ? [absolutePattern]
          : [];
    } catch (cause) {
      if (isRecord(cause) && cause.code !== undefined && cause.code !== "EINVAL") throw cause;
      hasUnmatchedPattern = true;
      continue;
    }
    if (matches.length === 0) {
      hasUnmatchedPattern = true;
      continue;
    }

    let patternMatchedSql = false;
    for (const match of matches) {
      const info = await stat(match);
      const expanded = info.isDirectory()
        ? await sqlFilesInDirectory(match)
        : match.endsWith(".sql")
          ? [match]
          : [];
      if (expanded.length > 0) patternMatchedSql = true;
      for (const file of expanded) {
        if (!seen.has(file)) {
          seen.add(file);
          files.push(file);
        }
      }
    }
    if (!patternMatchedSql) hasUnmatchedPattern = true;
  }

  return { files, hasUnmatchedPattern };
}

async function conventionalMigrationFiles(configDir: string): Promise<ReadonlyArray<string>> {
  const migrationsDir = join(configDir, "migrations");
  if (!(await exists(migrationsDir))) return [];
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && migrationFilePattern.test(entry.name))
    .map((entry) => join(migrationsDir, entry.name))
    .sort();
}

function portableProjectPath(projectRoot: string, file: string): string {
  const projectRelative = relative(projectRoot, file);
  if (
    projectRelative === "" ||
    projectRelative === ".." ||
    projectRelative.startsWith(`..${sep}`)
  ) {
    return file.split(sep).join("/");
  }
  return projectRelative.split(sep).join("/");
}

async function seedFile(projectRoot: string, path: string): Promise<DatabaseSeedFile> {
  const contents = await readFile(path);
  return {
    path,
    historyPath: portableProjectPath(projectRoot, path),
    checksum: createHash("sha256").update(contents).digest("hex"),
  };
}

export interface DatabaseBootstrapTranslation {
  readonly config: DatabaseBootstrapConfig | undefined;
  readonly warnings: ReadonlyArray<{
    readonly paths: ReadonlyArray<string>;
    readonly message: string;
  }>;
}

export const translateDatabaseBootstrapConfig = Effect.fnUntraced(function* (input: {
  readonly loadedProjectConfig: LoadedProjectConfig | null;
  readonly projectEnvironment: ProjectEnvironment | null;
  readonly projectRoot: string;
}) {
  if (input.loadedProjectConfig === null) {
    return { config: undefined, warnings: [] };
  }

  const loaded = input.loadedProjectConfig;
  const configDir = dirname(loaded.path);

  return yield* Effect.tryPromise({
    try: async (): Promise<DatabaseBootstrapTranslation> => {
      const schemaPathsConfigured =
        rawDefines(loaded, ["db", "migrations", "schema_paths"]) ||
        remoteDefines(loaded, ["db", "migrations", "schema_paths"]) ||
        environmentOverride("SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS", input.projectEnvironment) !==
          undefined;
      if (schemaPathsConfigured) {
        throw invalidLocalStackConfig(
          "db.migrations.schema_paths",
          "Use the legacy local stack until declarative schema diffing is implemented.",
        );
      }

      const migrationsEnabled = resolveBoolean({
        loaded,
        environment: input.projectEnvironment,
        path: ["db", "migrations", "enabled"],
        envName: "SUPABASE_DB_MIGRATIONS_ENABLED",
        configured: loaded.config.db.migrations.enabled,
      });
      const seedEnabled = resolveBoolean({
        loaded,
        environment: input.projectEnvironment,
        path: ["db", "seed", "enabled"],
        envName: "SUPABASE_DB_SEED_ENABLED",
        configured: loaded.config.db.seed.enabled,
      });

      const seedPatterns = resolveList({
        loaded,
        environment: input.projectEnvironment,
        path: ["db", "seed", "sql_paths"],
        envName: "SUPABASE_DB_SEED_SQL_PATHS",
        configured: loaded.config.db.seed.sql_paths,
      });

      let migrationFiles: ReadonlyArray<string> = [];
      try {
        migrationFiles = migrationsEnabled ? await conventionalMigrationFiles(configDir) : [];
      } catch {
        throw invalidLocalStackConfig(
          "db.migrations",
          "Ensure the migrations directory is readable, or use the legacy local stack.",
        );
      }
      if (migrationFiles.length > 0) {
        throw invalidLocalStackConfig(
          "db.migrations.enabled",
          "Use the legacy local stack until migration execution preserves transaction boundaries and statement history.",
        );
      }
      const resolvedSeeds =
        seedEnabled && seedPatterns.length > 0
          ? await expandSqlPatterns({
              patterns: seedPatterns,
              configDir,
            })
          : { files: [], hasUnmatchedPattern: false };
      const seedFiles = await Promise.all(
        resolvedSeeds.files.map((path) => seedFile(input.projectRoot, path)),
      );

      const config = seedFiles.length === 0 ? undefined : { seedFiles };
      return {
        config,
        warnings: resolvedSeeds.hasUnmatchedPattern
          ? [
              {
                paths: ["db.seed.sql_paths"],
                message:
                  "Some configured db.seed.sql_paths patterns matched no SQL files and were skipped.",
              },
            ]
          : [],
      };
    },
    catch: (cause) =>
      cause instanceof LocalStackConfigError
        ? cause
        : new LocalStackConfigError({
            detail: "Invalid local stack configuration at db.seed.sql_paths.",
            suggestion: "Ensure configured seed paths are readable.",
            paths: ["db.seed.sql_paths"],
          }),
  });
});
