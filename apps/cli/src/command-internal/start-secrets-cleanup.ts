import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { Effect } from "effect";

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
export function cleanupStartSecrets(
  containers: ReadonlyArray<ContainerIdName>,
  fallbackWorkdir: string,
): Effect.Effect<void> {
  return Effect.tryPromise(() =>
    Promise.all(
      containers.map((container) => {
        const workdir = container.workdir.length > 0 ? container.workdir : fallbackWorkdir;
        const stagingRoot = resolve(workdir, "supabase", ".temp", "start-secrets");
        const target = resolve(stagingRoot, container.name);
        if (target === stagingRoot || !target.startsWith(stagingRoot + sep)) {
          return Promise.resolve();
        }
        return rm(target, {
          recursive: true,
          force: true,
        });
      }),
    ),
  ).pipe(
    Effect.asVoid,
    Effect.orElseSucceed(() => undefined),
  );
}
