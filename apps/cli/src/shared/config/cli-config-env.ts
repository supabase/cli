import { ConfigProvider, Effect, FileSystem, Option, Path } from "effect";

import { parseDotEnv } from "../../command-internal/dotenv.ts";
import { CliConfigLoadError } from "./cli-config.errors.ts";

const DEFAULT_SUPABASE_ENV = "development";

/** A sparse numeric name such as `RUN_2000000` would otherwise cost one provider load per index. */
const MAX_NUMERIC_SEGMENTS = 256;

/** The ambient shell environment: what the provider's key trie exposes, plus names loaded on demand. */
export interface CliShellEnvironment {
  /** `undefined` when unset; a set-but-empty variable is `""` only if the provider preserves it. */
  readonly get: (name: string) => string | undefined;
  readonly entries: () => ReadonlyMap<string, string>;
  /** Loads each name straight from the provider, for names the key trie cannot reveal. */
  readonly load: (names: Iterable<string>) => Effect.Effect<void, CliConfigLoadError>;
}

/**
 * Reads the ambient `ConfigProvider`. The key-trie walk only discovers names; it misses `orElse`
 * fallbacks, lookup-only providers and names added after construction, so every name a caller
 * depends on is also loaded directly, via `names` here or `load` later.
 */
export const readShellEnvironment = Effect.fn("CliConfigEnv.readShell")(function* (options?: {
  readonly names?: Iterable<string>;
}) {
  const provider = yield* ConfigProvider.ConfigProvider;
  const variables = new Map<string, string>();
  const attempted = new Set<string>();

  const loadPath = (path: ReadonlyArray<string | number>) =>
    provider
      .load(path)
      .pipe(
        Effect.mapError(
          () => new CliConfigLoadError({ message: "failed to resolve environment variables" }),
        ),
      );

  const walk = (path: ReadonlyArray<string | number>): Effect.Effect<void, CliConfigLoadError> =>
    loadPath(path).pipe(
      Effect.flatMap((node) => {
        if (node === undefined) return Effect.void;
        if (node.value !== undefined && path.length > 0) variables.set(path.join("_"), node.value);
        const children =
          node._tag === "Record"
            ? [...node.keys]
            : node._tag === "Array"
              ? Array.from({ length: Math.min(node.length, MAX_NUMERIC_SEGMENTS) }, (_, i) => i)
              : [];
        return Effect.forEach(children, (child) => walk([...path, child]), { discard: true });
      }),
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

  yield* walk([]);
  yield* load(options?.names ?? []);

  return {
    get: (name) => variables.get(name),
    entries: () => variables,
    load,
  } satisfies CliShellEnvironment;
});

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
        yield* shell.load([key]);
        if (shell.get(key) !== undefined) continue;
        values[key] = value;
        files[key] = filePath;
      }
    }
  }
  return { values, files } satisfies CliProjectEnvFiles;
});
