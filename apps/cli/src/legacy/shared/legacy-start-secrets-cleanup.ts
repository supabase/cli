import { rm } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

/**
 * Best-effort removal of `legacyStageStartSecretFiles`'s
 * (`legacy/commands/start/lib/container-lifecycle.ts`) per-container
 * staged-secret directories for every name in `containerNames` — plaintext
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
 * `containerNames` MUST be the names Docker itself reported as matching the
 * same label filter the caller is about to tear down (or just did), captured
 * BEFORE that teardown runs — never independently reconstructed/guessed.
 * This avoids a blanket delete of the whole `start-secrets/` parent
 * directory, which would be unsafe if a workdir's project id ever changed
 * across `start` runs without an intervening `stop`: that parent could then
 * hold subdirectories for more than one project id, some possibly still
 * backing a live `restartPolicy: "unless-stopped"` container a narrower
 * `stop --project-id`/rollback isn't tearing down.
 *
 * Never fails: a directory that was never staged (every service besides
 * Kong/Postgres/Supavisor) is a harmless no-op, and a real deletion error is
 * not worth failing `stop`/rollback over.
 */
export function legacyCleanupStartSecrets(
  workdir: string,
  containerNames: ReadonlyArray<string>,
): Effect.Effect<void> {
  return Effect.tryPromise(() =>
    Promise.all(
      containerNames.map((name) =>
        rm(join(workdir, "supabase", ".temp", "start-secrets", name), {
          recursive: true,
          force: true,
        }),
      ),
    ),
  ).pipe(
    Effect.asVoid,
    Effect.orElseSucceed(() => undefined),
  );
}
