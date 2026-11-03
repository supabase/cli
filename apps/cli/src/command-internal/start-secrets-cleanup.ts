import { Effect, FileSystem, Path } from "effect";

import { legacyProjectStatePaths } from "../shared/config/legacy-project-state.paths.ts";

import type { ContainerIdName } from "./docker-lifecycle.ts";

/**
 * Best-effort removal of the per-container staged-secret directories some `start` services put
 * on host disk (today only Edge Runtime). Used by `start`'s rollback and by `stop`; never fails.
 *
 * Each directory is resolved under the container's own workdir label (`fallbackWorkdir` only
 * when the label is empty) so a `--project-id`/`--all` teardown can't orphan another project's
 * secrets, and it must be a direct child of the staging root because `container.name` is
 * untrusted `docker ps` metadata. `containers` must be exactly what Docker reported for the
 * completed teardown: a container that survived removal keeps its secrets.
 */
export const cleanupStartSecrets = Effect.fnUntraced(function* (
  containers: ReadonlyArray<ContainerIdName>,
  fallbackWorkdir: string,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.forEach(
    containers,
    (container) => {
      const workdir = container.workdir.length > 0 ? container.workdir : fallbackWorkdir;
      const stagingRoot = legacyProjectStatePaths({ join: path.resolve }, workdir).startSecretsDir;
      const target = path.resolve(stagingRoot, container.name);
      if (target === stagingRoot || !target.startsWith(stagingRoot + path.sep)) {
        return Effect.void;
      }
      /* Interruptible even in the start and stop finalizers, so the first failure ends cleanup. */
      return Effect.interruptible(fs.remove(target, { recursive: true, force: true }));
    },
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.ignore);
});
