import { Effect, FileSystem, Path } from "effect";

export interface ProjectPaths {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly configPath: string;
  readonly envPath: string;
  readonly envLocalPath: string;
}

const findConfigInRoot = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const supabaseDir = path.join(root, "supabase");
  const jsonPath = path.join(supabaseDir, "config.json");
  const tomlPath = path.join(supabaseDir, "config.toml");

  const jsonExists = yield* fs.exists(jsonPath);
  const tomlExists = yield* fs.exists(tomlPath);

  if (!jsonExists && !tomlExists) {
    return null;
  }

  return {
    projectRoot: root,
    supabaseDir,
    configPath: jsonExists ? jsonPath : tomlPath,
    envPath: path.join(supabaseDir, ".env"),
    envLocalPath: path.join(supabaseDir, ".env.local"),
  } satisfies ProjectPaths;
});

export const findProjectPaths = Effect.fnUntraced(function* (cwd: string) {
  const path = yield* Path.Path;
  let current = path.resolve(cwd);

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

export const findProjectRoot = Effect.fnUntraced(function* (cwd: string) {
  const paths = yield* findProjectPaths(cwd);
  return paths?.projectRoot ?? null;
});
