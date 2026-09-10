import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { Effect } from "effect";

import type { ContainerIdName } from "./docker-lifecycle.ts";

/**
 * Best-effort removal of per-container staged-secret directories: plaintext secret/env
 * material some `start` services stage on host disk. Used by `start`'s rollback and `stop`.
 * Only Edge Runtime still stages anything here; an unstaged directory is a harmless no-op.
 *
 * Each container's directory is resolved under its own workdir label, not the caller's
 * `fallbackWorkdir` (used only when a container's label is empty) — otherwise a
 * `--project-id`/`--all` teardown could orphan a different project's secrets.
 *
 * `containers` must be exactly what Docker reported for the just-completed teardown, never
 * reconstructed or a pre-teardown snapshot — a container that failed to be removed must keep
 * its secrets, and this also avoids ever deleting the whole `start-secrets/` parent.
 *
 * Never fails. `container.name` is external `docker ps` metadata, so the resolved candidate
 * must be a direct child of the staging root before deletion — this also covers an empty name.
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
