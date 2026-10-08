import { Config, ConfigProvider, Effect, FileSystem, Option, Path } from "effect";

import { parseDotEnv } from "../command-internal/dotenv.ts";
import { CliConfigLoadError } from "./cli-config.errors.ts";

const DEFAULT_SUPABASE_ENV = "development";

interface CliProjectEnvFiles {
  readonly values: Readonly<Record<string, string>>;
  /** The absolute path of the file each value came from. */
  readonly files: Readonly<Record<string, string>>;
}

/** Reads one variable through the ambient `ConfigProvider`; a set-but-empty variable is `Some("")`. */
const readShellEnv = (name: string): Effect.Effect<Option.Option<string>, CliConfigLoadError> =>
  Config.option(Config.string(name)).pipe(
    Effect.mapError(
      () => new CliConfigLoadError({ message: `failed to resolve environment variable: ${name}` }),
    ),
  );

/**
 * Every variable the ambient `ConfigProvider` exposes, by walking its key trie. A set-but-empty
 * variable is present only when the provider preserves empty strings.
 */
export const readShellEnvironment = Effect.fn("CliConfigEnv.readShell")(function* () {
  const provider = yield* ConfigProvider.ConfigProvider;
  const variables = new Map<string, string>();
  const walk = (path: ReadonlyArray<string | number>): Effect.Effect<void, CliConfigLoadError> =>
    provider.load(path).pipe(
      Effect.mapError(
        () => new CliConfigLoadError({ message: "failed to resolve environment variables" }),
      ),
      Effect.flatMap((node) => {
        if (node === undefined) return Effect.void;
        if (node.value !== undefined && path.length > 0) variables.set(path.join("_"), node.value);
        const children =
          node._tag === "Record"
            ? [...node.keys]
            : node._tag === "Array"
              ? Array.from({ length: node.length }, (_, index) => index)
              : [];
        return Effect.forEach(children, (child) => walk([...path, child]), { discard: true });
      }),
    );
  yield* walk([]);
  return variables;
});

/**
 * Loads the project `.env*` files without touching the process environment. Files are read in
 * `SUPABASE_ENV` order under `supabase/` and then the workdir; the first writer of a key wins, and a
 * key the shell already sets, even to the empty string, is never taken from a file.
 */
export const loadCliProjectEnvFiles = Effect.fn("CliConfigEnv.load")(function* (
  workdir: string,
  options?: { readonly shell?: ReadonlyMap<string, string> },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const shellHas = (name: string) =>
    options?.shell === undefined
      ? readShellEnv(name)
      : Effect.succeed(Option.fromNullishOr(options.shell.get(name)));

  const selected = Option.filter(yield* shellHas("SUPABASE_ENV"), (value) => value.length > 0);
  const env = Option.getOrElse(selected, () => DEFAULT_SUPABASE_ENV);
  const filenames = [`.env.${env}.local`];
  if (env !== "test") filenames.push(".env.local");
  filenames.push(`.env.${env}`, ".env");

  const values: Record<string, string> = {};
  const files: Record<string, string> = {};
  for (const dir of [path.join(workdir, "supabase"), workdir]) {
    for (const name of filenames) {
      const filePath = path.join(dir, name);
      const content = yield* fs.readFileString(filePath).pipe(
        Effect.map(Option.some<string>),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new CliConfigLoadError({ message: `failed to read environment file: ${name}` }),
              ),
        ),
      );
      if (Option.isNone(content)) continue;
      const parsed = yield* Effect.try({
        try: () => parseDotEnv(content.value),
        catch: () =>
          new CliConfigLoadError({ message: `failed to parse environment file: ${name}` }),
      });
      for (const [key, value] of Object.entries(parsed)) {
        if (values[key] !== undefined) continue;
        if (Option.isSome(yield* shellHas(key))) continue;
        values[key] = value;
        files[key] = filePath;
      }
    }
  }
  return { values, files } satisfies CliProjectEnvFiles;
});
