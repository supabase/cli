import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { Effect } from "effect";

import type { LegacyContainerIdName } from "./legacy-docker-lifecycle.ts";

/**
 * Best-effort removal of `legacyStageStartSecretFiles`'s
 * (`legacy/shared/db-bootstrap/container-lifecycle.ts`) per-container
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
 * You Duplicate" rule: both `start`'s own rollback (`legacy/shared/db-bootstrap/rollback.ts`) and
 * `stop` (`stop.handler.ts`) need this same cleanup.
 *
 * Each container's own directory is resolved as `<workdir>/supabase/.temp/
 * start-secrets/<dirId>`, where `dirId` is `container.secretDirId` when present
 * (an unnamed container's own `LEGACY_CLI_SECRET_DIR_LABEL` value — see that
 * constant's doc comment for why `container.name` can't be used for one of
 * those) and `container.name` otherwise, and `workdir` is that container's own
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
 * Kong/Postgres/Supavisor, and the shadow database before CLI-1956) is a
 * harmless no-op, and a real deletion error is not worth failing
 * `stop`/rollback over.
 *
 * `dirId` is a Docker label value read back off whatever containers matched
 * the caller's label filter (`legacyListContainerIdsAndNames`) — external
 * metadata, not something this function generated itself, so it cannot be
 * trusted as a bare path segment. A container that matches the project-label
 * filter (any container can carry that label; Docker doesn't scope who may
 * set it) but carries a crafted `LEGACY_CLI_SECRET_DIR_LABEL` value containing
 * `..` segments must never be able to walk the subsequent `rm -rf` outside
 * `start-secrets/` and onto arbitrary host paths. Resolve the candidate and
 * require it to be a direct child of the staging root before deleting it —
 * same defence-in-depth shape as `bootstrap.templates.ts`'s identical guard
 * against a GitHub-supplied path escaping its target directory. This also
 * covers the degenerate case where `dirId` ends up empty (would otherwise
 * resolve to the staging root itself and wipe every project's secrets).
 */
export function legacyCleanupStartSecrets(
  containers: ReadonlyArray<LegacyContainerIdName>,
  fallbackWorkdir: string,
): Effect.Effect<void> {
  return Effect.tryPromise(() =>
    Promise.all(
      containers.map((container) => {
        const workdir = container.workdir.length > 0 ? container.workdir : fallbackWorkdir;
        const dirId = container.secretDirId.length > 0 ? container.secretDirId : container.name;
        const stagingRoot = resolve(workdir, "supabase", ".temp", "start-secrets");
        const target = resolve(stagingRoot, dirId);
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
