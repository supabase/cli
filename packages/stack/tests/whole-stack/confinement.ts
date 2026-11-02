import { expect } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

interface TreeEntry {
  readonly isFile: boolean;
  readonly size: bigint;
  readonly mtimeMs: number;
}

export type Tree = ReadonlyMap<string, TreeEntry>;

/**
 * Snapshots every path under `root`, or an empty tree when `root` does not exist yet. A directory
 * listed in `opaque` is recorded but never entered, for data a container engine owns under a
 * mapped uid that the host user cannot traverse.
 */
export const snapshotTree = Effect.fn("Confinement.snapshotTree")(function* (
  root: string,
  opaque: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(root))) return new Map<string, TreeEntry>();
  const entries = new Map<string, TreeEntry>();
  const visit = (directory: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const names = yield* fs.readDirectory(directory);
      yield* Effect.forEach(
        names,
        (name) =>
          Effect.gen(function* () {
            const full = path.join(directory, name);
            const info = yield* fs.stat(full).pipe(Effect.option);
            // A path can disappear between listing and stat (e.g. a service's own temp file); treat
            // it as absent rather than failing the whole snapshot.
            if (Option.isNone(info)) {
              entries.set(full, { isFile: false, size: 0n, mtimeMs: 0 });
              return;
            }
            entries.set(full, {
              isFile: info.value.type === "File",
              size: info.value.size,
              mtimeMs: Option.match(info.value.mtime, {
                onNone: () => 0,
                onSome: (date) => date.getTime(),
              }),
            });
            // A symlink is recorded but not followed, matching a recursive directory listing.
            if (
              info.value.type === "Directory" &&
              !opaque.includes(full) &&
              (yield* fs.readLink(full).pipe(Effect.isFailure))
            )
              yield* visit(full);
          }),
        { concurrency: 8, discard: true },
      );
    }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
    );
  yield* visit(root);
  return entries as Tree;
});

export interface ConfinementViolation {
  readonly path: string;
  readonly kind: "created" | "modified";
}

/** Flags every path that is new or changed between two snapshots of the same root. */
export const diffTrees = (before: Tree, after: Tree): ReadonlyArray<ConfinementViolation> => {
  const violations: Array<ConfinementViolation> = [];
  for (const [entryPath, entry] of after) {
    const previous = before.get(entryPath);
    if (previous === undefined) violations.push({ path: entryPath, kind: "created" });
    else if (entry.isFile && (entry.size !== previous.size || entry.mtimeMs !== previous.mtimeMs))
      violations.push({ path: entryPath, kind: "modified" });
  }
  return violations;
};

/** Fails, listing every offending path, when a violation falls outside the allowed roots. */
export const assertConfinedTo = (
  violations: ReadonlyArray<ConfinementViolation>,
  allowedRoots: ReadonlyArray<string>,
): void => {
  const isAllowed = (candidate: string) =>
    allowedRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
  const offending = violations.filter((violation) => !isAllowed(violation.path));
  expect(
    offending,
    `Stack wrote outside its allowed roots (${allowedRoots.join(", ")}):\n${offending
      .map((violation) => `  ${violation.kind}: ${violation.path}`)
      .join("\n")}`,
  ).toEqual([]);
};

/**
 * Negative control: proves `assertConfinedTo` actually flags an unauthorized write under `root`,
 * for both a write that persists and one created and then removed again before the next snapshot
 * (the gap a before/after-only check would otherwise miss). Cleans up after itself so it leaves no
 * trace for the scenario's own, later checks.
 */
export const proveConfinementDetectsViolations = Effect.fn(
  "Confinement.proveConfinementDetectsViolations",
)(function* (root: string, baseline: Tree, allowedRoots: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const persistentMarker = path.join(root, ".confinement-control-persistent");
  const transientMarker = path.join(root, ".confinement-control-transient");
  yield* fs.writeFileString(persistentMarker, "control");
  yield* fs.writeFileString(transientMarker, "control");
  const withBothMarkers = diffTrees(baseline, yield* snapshotTree(root));
  expect(withBothMarkers.map((violation) => violation.path).sort()).toEqual(
    [persistentMarker, transientMarker].sort(),
  );
  expect(() => assertConfinedTo(withBothMarkers, allowedRoots)).toThrow();
  yield* fs.remove(transientMarker, { force: true });
  const afterTransientRemoved = diffTrees(baseline, yield* snapshotTree(root));
  // The residual gap: a write made and undone strictly between two snapshot points is invisible
  // to a diff taken only afterward, unlike the persistent one.
  expect(afterTransientRemoved.map((violation) => violation.path)).toEqual([persistentMarker]);
  yield* fs.remove(persistentMarker, { force: true });
});

/**
 * Environment names the stack, its workloads, or the test harness's own Bun runtime resolve a
 * user-level root from.
 */
const sandboxEnvNames = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  // Bun's own JIT transpile cache; a test-harness concern, not a stack confinement one.
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  // Pre-resolved, in the real environment, to the endpoint the engine's own context store would
  // have answered: once set, the owner's pinned target resolution skips that store entirely, so
  // it never needs `~/.docker` under the sandboxed HOME below. Exposing that real config directory
  // instead would also expose its credential store, which a real pull would then invoke under the
  // sandboxed HOME, writing outside what this test allows.
  "DOCKER_HOST",
] as const;

type SandboxEnvName = (typeof sandboxEnvNames)[number];

export type SandboxEnvironment = Readonly<Record<SandboxEnvName, string>>;

/**
 * Runs `use` with the given variables set on the process environment, so a detached stack owner
 * spawned during `use` inherits them, and restores the previous values once `use` completes.
 */
export const withSandboxEnvironment = <A, E, R>(
  values: SandboxEnvironment,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous: Partial<Record<SandboxEnvName, string>> = {};
      for (const name of sandboxEnvNames) {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect, effecttsgo/process-env -- the detached stack owner and the harness's own Bun process inherit these at spawn time; this is not application config.
        previous[name] = process.env[name];
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above.
        process.env[name] = values[name];
      }
      return previous;
    }),
    () => use,
    (previous) =>
      Effect.sync(() => {
        for (const name of sandboxEnvNames) {
          const value = previous[name];
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- restores the mutation made above.
          if (value === undefined) delete process.env[name];
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- restores the mutation made above.
          else process.env[name] = value;
        }
      }),
  );
