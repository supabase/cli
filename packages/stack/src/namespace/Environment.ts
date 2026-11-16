import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { lstatPath } from "./drivers/FileSystem.ts";

/**
 * Variables a native workload's environment is confined to. Every one of them is rooted under the
 * owned directory {@link confine} is given, so a caller cannot redirect a workload's home, temp,
 * cache, config, data, state or Deno directory outside it.
 */
const CONFINED_KEYS = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "DENO_DIR",
] as const;
type ConfinedKey = (typeof CONFINED_KEYS)[number];

/** The owned environment a native workload's spec must carry; constructed only by {@link confine}. */
export interface NativeEnvironment {
  readonly values: Readonly<Record<ConfinedKey, string>>;
}

/** A caller tried to set an environment variable the namespace confines; it names every one. */
export class EnvironmentOverrideError extends Schema.TaggedError<EnvironmentOverrideError>()(
  "Namespace.EnvironmentOverrideError",
  { keys: Schema.Array(Schema.String) },
) {}

/**
 * A reused environment component (the owned root or one nested under it) is a symlink or junction,
 * which its current owner (a step-down user, for example) could have planted between launches.
 */
export class EnvironmentSymlinkError extends Schema.TaggedError<EnvironmentSymlinkError>()(
  "Namespace.EnvironmentSymlinkError",
  { path: Schema.String },
) {}

/** Every path component from `root` down to (and including) `target`, root first. */
const componentsFrom = (path: Path.Path, root: string, target: string): ReadonlyArray<string> => {
  const relative = path.relative(root, target);
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  const components: Array<string> = [root];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    components.push(current);
  }
  return components;
};

/**
 * Builds the confined environment for a native workload rooted at `root`: `root` itself is HOME,
 * with a temp, cache, config, data, state and Deno directory nested under it. On reuse, a prior
 * launch's confined directories could have been replaced with a symlink or junction by their
 * current owner; every component from `root` down is rejected if so, before anything is created
 * through it. Creates every directory so the workload finds them ready on first use.
 */
export const confine = Effect.fn("Namespace.Environment.confine")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.fn.Return<NativeEnvironment, PlatformError | EnvironmentSymlinkError> {
  const home = root;
  const tmp = path.join(home, "tmp");
  const values: Record<ConfinedKey, string> = {
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    DENO_DIR: path.join(home, ".cache", "deno"),
  };
  const directories = new Set(Object.values(values));
  const components = new Set<string>([root]);
  for (const directory of directories)
    for (const component of componentsFrom(path, root, directory)) components.add(component);
  for (const component of components)
    if ((yield* lstatPath(component))?.type === "SymbolicLink")
      return yield* new EnvironmentSymlinkError({ path: component });
  for (const directory of directories)
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  return { values };
});

/**
 * Merges `environment`'s confined values into `callerEnv`, failing instead of letting `callerEnv`
 * override any of them.
 */
export const apply = (
  environment: NativeEnvironment,
  callerEnv: Readonly<Record<string, string>> = {},
): Effect.Effect<Record<string, string>, EnvironmentOverrideError> => {
  const overridden = CONFINED_KEYS.filter((key) => key in callerEnv);
  if (overridden.length > 0) return Effect.fail(new EnvironmentOverrideError({ keys: overridden }));
  return Effect.succeed({ ...callerEnv, ...environment.values });
};
