import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

export interface CliProjectPaths {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly configPath: string;
  readonly envPath: string;
  readonly envLocalPath: string;
}

// Any stat failure (e.g. ENOTDIR when this root has a file named `supabase`) means "no config
// here", not a fatal error — log it at Debug and keep searching.
const probeExists = (self: Effect.Effect<boolean, PlatformError>) =>
  self.pipe(
    Effect.tapError((error) => Effect.logDebug("config probe failed", error)),
    Effect.orElseSucceed(() => false),
  );

const findConfigInRoot = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const supabaseDir = path.join(root, "supabase");
  const jsonPath = path.join(supabaseDir, "config.json");
  const tomlPath = path.join(supabaseDir, "config.toml");

  const jsonExists = yield* probeExists(fs.exists(jsonPath));
  const tomlExists = yield* probeExists(fs.exists(tomlPath));

  if (!jsonExists && !tomlExists) {
    return null;
  }

  return {
    projectRoot: root,
    supabaseDir,
    configPath: jsonExists ? jsonPath : tomlPath,
    envPath: path.join(supabaseDir, ".env"),
    envLocalPath: path.join(supabaseDir, ".env.local"),
  } satisfies CliProjectPaths;
});

export interface FindCliProjectPathsOptions {
  /**
   * When `false`, only `cwd` itself is checked — no ancestor climb. Pass `false` when the
   * caller already holds an authoritative project root, to avoid picking up an unrelated
   * ancestor's config. Defaults to `true`.
   */
  readonly search?: boolean;
}

export const findCliProjectPaths = Effect.fnUntraced(function* (
  cwd: string,
  options?: FindCliProjectPathsOptions,
) {
  const path = yield* Path.Path;
  const start = path.resolve(cwd);

  if (options?.search === false) {
    return yield* findConfigInRoot(start);
  }

  let current = start;
  while (true) {
    const match = yield* findConfigInRoot(current);

    if (match !== null) {
      return match;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
});

export const findCliProjectRoot = Effect.fnUntraced(function* (
  cwd: string,
  options?: FindCliProjectPathsOptions,
) {
  const paths = yield* findCliProjectPaths(cwd, options);
  return paths?.projectRoot ?? null;
});
