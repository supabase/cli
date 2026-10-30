import { ConfigProvider, Effect, FileSystem, Option, Path, type PlatformError } from "effect";

import { parseDotEnv } from "./dotenv.ts";
import { CliConfigLoadError } from "./cli-config-load.errors.ts";
import { CliEnvNameSource } from "./cli-config-provider.layer.ts";

const DEFAULT_SUPABASE_ENV = "development";

/** The ambient shell environment: only the names a caller asked for, loaded straight from the provider. */
export interface CliShellEnvironment {
  /** `undefined` when unset; a set-but-empty variable is `""` only if the provider preserves it. */
  readonly get: (name: string) => string | undefined;
  /** The set variables among the names loaded so far. */
  readonly entries: () => ReadonlyMap<string, string>;
  /** Loads each name straight from the provider; later lookups see it through `get`. */
  readonly load: (names: Iterable<string>) => Effect.Effect<void, CliConfigLoadError>;
}

/**
 * Reads the ambient `ConfigProvider` by name. The provider is never enumerated, so lookup-only
 * providers and `orElse` fallbacks behave the same as a plain environment.
 */
export const readShellEnvironment = Effect.fn("CliConfigEnv.readShell")(function* (options?: {
  readonly names?: Iterable<string>;
  /** Loads every variable named `<prefix>` or `<prefix>_*` that the environment name source lists. */
  readonly namesWithPrefix?: Iterable<string>;
}) {
  const provider = yield* ConfigProvider.ConfigProvider;
  const variables = new Map<string, string>();
  const attempted = new Set<string>();
  const listNames = yield* CliEnvNameSource;

  const loadPath = (path: ReadonlyArray<string | number>) =>
    provider
      .load(path)
      .pipe(
        Effect.mapError(
          () => new CliConfigLoadError({ message: "failed to resolve environment variables" }),
        ),
      );

  const load = (names: Iterable<string>) =>
    Effect.forEach(
      names,
      (name) => {
        if (attempted.has(name)) return Effect.void;
        attempted.add(name);
        return loadPath([name]).pipe(
          Effect.map((node) => {
            if (node?.value !== undefined) variables.set(name, node.value);
          }),
        );
      },
      { discard: true },
    );

  yield* load(options?.names ?? []);
  const prefixes = [...(options?.namesWithPrefix ?? [])];
  if (prefixes.length > 0) {
    const listed = [...listNames()];
    yield* load(
      listed.filter((name) =>
        prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}_`)),
      ),
    );
  }

  return {
    get: (name) => variables.get(name),
    entries: () => variables,
    load,
  } satisfies CliShellEnvironment;
});

/** The dotenv filenames for a `SUPABASE_ENV` value, highest precedence first. */
export const candidateDotenvFilenames = (env: string): ReadonlyArray<string> => [
  `.env.${env}.local`,
  ...(env === "test" ? [] : [".env.local"]),
  `.env.${env}`,
  ".env",
];

const ABSENT_FILE_CODES: ReadonlySet<unknown> = new Set(["ELOOP", "ENOTDIR"]);

/** A missing file, a symlink loop, or a path through a non-directory: all read as "no such file". */
const isAbsentFileReason = (reason: PlatformError.PlatformError["reason"]): boolean => {
  if (reason._tag === "NotFound") return true;
  if (reason._tag !== "BadResource") return false;
  const { cause } = reason;
  return typeof cause === "object" && cause !== null && "code" in cause
    ? ABSENT_FILE_CODES.has(cause.code)
    : false;
};

interface CliProjectEnvFiles {
  readonly values: Readonly<Record<string, string>>;
  /** The absolute path of the file each value came from. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Loads the project `.env*` files without touching the process environment. Files are read in
 * `SUPABASE_ENV` order under `supabase/` and then the workdir; the first writer of a key wins, and a
 * key the shell already sets, even to the empty string, is never taken from a file.
 */
export const loadCliProjectEnvFiles = Effect.fn("CliConfigEnv.load")(function* (
  workdir: string,
  options?: { readonly shell?: CliShellEnvironment },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shell = options?.shell ?? (yield* readShellEnvironment());

  yield* shell.load(["SUPABASE_ENV"]);
  const selected = Option.filter(
    Option.fromNullishOr(shell.get("SUPABASE_ENV")),
    (value) => value.length > 0,
  );
  const env = Option.getOrElse(selected, () => DEFAULT_SUPABASE_ENV);
  const filenames = [...new Set(candidateDotenvFilenames(env))];

  const values: Record<string, string> = Object.create(null);
  const files: Record<string, string> = Object.create(null);
  let fileCount = 0;
  for (const dir of [path.join(workdir, "supabase"), workdir]) {
    for (const name of filenames) {
      const filePath = path.join(dir, name);
      const displayPath = path.relative(workdir, filePath);
      const content = yield* fs.readFileString(filePath).pipe(
        Effect.map(Option.some<string>),
        Effect.catchTag("PlatformError", (error) =>
          isAbsentFileReason(error.reason)
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new CliConfigLoadError({
                  message: `failed to read environment file: ${displayPath}`,
                }),
              ),
        ),
      );
      if (Option.isNone(content)) continue;
      fileCount += 1;
      const parsed = yield* Effect.try({
        try: () => parseDotEnv(content.value),
        catch: () =>
          new CliConfigLoadError({ message: `failed to parse environment file: ${displayPath}` }),
      });
      for (const [key, value] of Object.entries(parsed)) {
        if (Object.hasOwn(values, key)) continue;
        yield* shell.load([key]);
        if (shell.get(key) !== undefined) continue;
        values[key] = value;
        files[key] = filePath;
      }
    }
  }
  yield* Effect.annotateCurrentSpan({ "file.count": fileCount });
  return { values, files } satisfies CliProjectEnvFiles;
});
