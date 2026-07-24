import { rm } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import type { LegacyContainerIdName } from "./legacy-docker-lifecycle.ts";

/**
 * Best-effort removal of `legacyStageStartSecretFiles`'s
 * (`legacy/commands/start/lib/container-lifecycle.ts`) per-container
 * staged-secret directories for every container in `containers` — plaintext
 * JWT/TLS/pgsodium/pooler secret material `start` stages on host disk (Kong,
 * Postgres, Supavisor) that otherwise survives indefinitely, since neither
 * `stop` nor a failed-start rollback previously touched
 * `<workdir>/supabase/.temp/start-secrets/`. There is no Go behavior to
 * match here — Go never stages secrets on host disk in the first place (it
 * injects them into `container.Config.Cmd`/`Entrypoint` directly via the
 * Docker Engine API) — this is a TS-port-only hygiene fix.
 *
 * Hoisted here (`legacy/shared/`) per `apps/cli/CLAUDE.md`'s "Hoist Before
 * You Duplicate" rule: both `start`'s own rollback (`start.rollback.ts`) and
 * `stop` (`stop.handler.ts`) need this same cleanup.
 *
 * Each container's own directory is resolved as `<workdir>/supabase/.temp/
 * start-secrets/<name>`, where `workdir` is that container's own
 * `LEGACY_CLI_WORKDIR_LABEL` value (see that constant's doc comment) — NOT
 * necessarily `fallbackWorkdir` (the caller's own `LegacyCliConfig.workdir`).
 * A caller tearing down containers by an explicit `--project-id`/`--all`
 * filter may be tearing down a DIFFERENT project's containers than the one
 * its own cwd/`--workdir` points at, so using the caller's workdir
 * unconditionally would look in the wrong directory and silently orphan that
 * project's staged secret files. `fallbackWorkdir` is used only for a
 * container whose own label is empty — created before this label existed
 * (or by a Go binary, which never sets it).
 *
 * `containers` MUST be exactly the containers Docker itself reported as
 * matching the same label filter the caller just tore down, and only once
 * that teardown is CONFIRMED complete (`legacyDockerRemoveAll`'s
 * `onContainersRemoved` hook) — never independently reconstructed/guessed,
 * and never a pre-teardown snapshot, since a container that a later stage
 * failed to actually remove must keep its secrets. This also avoids a
 * blanket delete of the whole `start-secrets/` parent directory, which would
 * be unsafe if a workdir's project id ever changed across `start` runs
 * without an intervening `stop`: that parent could then hold subdirectories
 * for more than one project id, some possibly still backing a live
 * `restartPolicy: "unless-stopped"` container a narrower `stop
 * --project-id`/rollback isn't tearing down.
 *
 * Never fails: a directory that was never staged (every service besides
 * Kong/Postgres/Supavisor) is a harmless no-op, and a real deletion error is
 * not worth failing `stop`/rollback over.
 */
export function legacyCleanupStartSecrets(
  containers: ReadonlyArray<LegacyContainerIdName>,
  fallbackWorkdir: string,
): Effect.Effect<void> {
  return Effect.tryPromise(() =>
    Promise.all(
      containers.map((container) => {
        const workdir = container.workdir.length > 0 ? container.workdir : fallbackWorkdir;
        return rm(join(workdir, "supabase", ".temp", "start-secrets", container.name), {
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
