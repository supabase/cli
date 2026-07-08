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

export interface FindProjectPathsOptions {
  /**
   * When `false`, only `cwd` itself is checked for `supabase/config.{json,toml}` —
   * no ancestor climb. Go's own resolution never searches twice: an explicit
   * `--workdir`/`SUPABASE_WORKDIR` is used exactly as given (`ChangeWorkDir`,
   * `apps/cli-go/internal/utils/misc.go:231-247`), and once `os.Chdir`'d there,
   * `config.toml` is read as a plain relative path with no further ancestor
   * search (`NewPathBuilder`, `pkg/config/utils.go:43-48`). Ancestor climbing in
   * Go only ever happens once, as the *default* when workdir is unset
   * (`getProjectRoot`, `internal/utils/misc.go:209-224`).
   *
   * Callers that already hold an authoritative, Go-equivalent project root
   * (e.g. the legacy `stop`/`status` ports' `cliConfig.workdir`, which mirrors
   * `ChangeWorkDir`'s own explicit-vs-default resolution) should pass `false`
   * here to avoid a second, un-Go-like ancestor search that could otherwise
   * pick up an unrelated ancestor project's config.
   *
   * Defaults to `true` (the original ancestor-search behavior), so existing
   * callers are unaffected.
   */
  readonly search?: boolean;
}

export const findProjectPaths = Effect.fnUntraced(function* (
  cwd: string,
  options?: FindProjectPathsOptions,
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

export const findProjectRoot = Effect.fnUntraced(function* (cwd: string) {
  const paths = yield* findProjectPaths(cwd);
  return paths?.projectRoot ?? null;
});
