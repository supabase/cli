/**
 * Generic PGDATA snapshot/restore primitives — container-agnostic on purpose. `shadow-cache.ts`
 * is the only caller today, but nothing here assumes "shadow": these are the building blocks for
 * savepointing ANY local Postgres container and restoring it into a fresh one — the shadow's
 * disk-level baseline cache today, a future save/restore for the long-running
 * `supabase_db_<project>` stack container tomorrow.
 *
 * **Coherence contract:** the container must be STOPPED before {@link legacyExportPgDataTar}
 * runs — a snapshot of a running Postgres's data directory is not a consistent thing to copy.
 * Callers own the stop/start around the export; this module only moves bytes.
 *
 * TODO(hot-save): the STOPPED contract could generalize to a consistency MODE. `frozen` —
 * `docker pause` → copy → `docker unpause` — yields a crash-consistent copy (connections stall
 * ~1s instead of dropping; restore boots through normal WAL recovery). `online` —
 * `pg_backup_start()` → fuzzy copy → `pg_backup_stop()`, writing the returned `backup_label`
 * into the artifact — is the zero-stall, Postgres-native form, and the ONLY one that also works
 * for a future NATIVE (non-container) Postgres process, where no freezer exists and recovery
 * replays the backup-labeled WAL range instead. Neither is worth the surface for the shadow
 * cache (its export runs once per key on an already-cold path); implement when a live-stack
 * savepoint feature needs to export without downtime.
 *
 * **Ownership caveat:** the restore side ({@link legacyPgDataRestoreArchive}) MUST be delivered as
 * a tar stream unpacked via `docker cp - <id>:<path>`, never a directory copy — a directory copy
 * resets ownership to the extracting user (root) and Postgres refuses to start on a data directory
 * it does not own, whereas the tar-stream form preserves each member's uid/gid verbatim.
 *
 * The artifact is a plain file, so it fits a future NATIVE (non-Docker) Postgres service just as
 * well — nothing about the format is container-specific.
 */

import { Effect, Stream, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  legacyCollectText,
  legacyDescribeContainerCliFailure,
  spawnContainerCli,
} from "../legacy-container-cli.ts";
import type { LegacyStartContainerSpec } from "./docker-create-args.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * `PGDATA` in every `supabase/postgres` image — the directory {@link legacyExportPgDataTar}
 * exports and {@link legacyPgDataRestoreArchive} restores. Hardcoded rather than read from the
 * container's own `PGDATA` env: the entrypoint scripts this codebase generates
 * (`postgres.service.ts`) never override it, and the value is part of the tar's own layout, so a
 * mismatch has to be a deliberate change here.
 */
export const LEGACY_PGDATA_PATH = "/var/lib/postgresql/data";

/**
 * `docker cp - <id>:<dest>` unpacks the archive's members RELATIVE to `dest`, and
 * {@link LEGACY_PGDATA_PATH}'s export tar has `data/` as its own top-level member, so the restore
 * target is PGDATA's parent. A POSIX constant, not `path.dirname` — this is a container path and
 * must not follow the host's separator.
 */
export const LEGACY_PGDATA_PARENT_PATH = "/var/lib/postgresql";

/**
 * Internal-only "the snapshot could not be produced" signal — deliberately NOT a
 * `Data.TaggedError`: every caller of {@link legacyExportPgDataTar} decides for itself how to
 * degrade (the shadow baseline cache warns and continues uncached), so this must not be mistaken
 * for a CLI-facing error.
 */
export interface LegacyPgDataSnapshotUnavailable {
  readonly reason: string;
}

const legacyPgDataSnapshotUnavailable = (reason: string): LegacyPgDataSnapshotUnavailable => ({
  reason,
});

/**
 * Streams `docker cp <containerId>:${LEGACY_PGDATA_PATH} -`'s tar straight to a temp file next to
 * `tarPath` and `rename`s it into place. The stream never lands in memory: the child's stdout is
 * piped into `FileSystem.sink`, so a large snapshot costs one buffer's worth of heap.
 *
 * The container must already be STOPPED (see this module's own header) — the caller owns the
 * stop/start around this call. The `rename` is the LAST step and is what publishes the entry: a
 * partially written tar must never be observable under the final name. Any failure removes the
 * temp file; nothing is left behind for a later run to find.
 */
export const legacyExportPgDataTar = (
  spawner: Spawner,
  containerId: string,
  fs: FileSystem.FileSystem,
  tarPath: string,
): Effect.Effect<void, LegacyPgDataSnapshotUnavailable> => {
  const tempPath = `${tarPath}.${process.pid}.partial`;
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawnContainerCli(
          spawner,
          ["cp", `${containerId}:${LEGACY_PGDATA_PATH}`, "-"],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        ).pipe(
          Effect.mapError((cause) =>
            legacyPgDataSnapshotUnavailable(
              `failed to export ${LEGACY_PGDATA_PATH}: ${legacyDescribeContainerCliFailure(cause)}`,
            ),
          ),
        );
        // stdout is consumed concurrently with awaiting the exit code, not after it: an
        // unread pipe would block `docker cp` long before it finished writing the archive.
        const [exitCode, , stderr] = yield* Effect.all(
          [
            child.exitCode.pipe(Effect.map(Number)),
            Stream.run(child.stdout, fs.sink(tempPath, { flag: "w" })),
            legacyCollectText(child.stderr),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError((cause) =>
            legacyPgDataSnapshotUnavailable(
              `failed to export ${LEGACY_PGDATA_PATH}: ${legacyDescribeContainerCliFailure(cause)}`,
            ),
          ),
        );
        if (exitCode !== 0) {
          const message = stderr.trim();
          return yield* Effect.fail(
            legacyPgDataSnapshotUnavailable(
              `docker cp exited ${exitCode}${message.length > 0 ? `: ${message}` : ""}`,
            ),
          );
        }
      }),
    );
    yield* fs
      .rename(tempPath, tarPath)
      .pipe(
        Effect.mapError((cause) =>
          legacyPgDataSnapshotUnavailable(`failed to publish ${tarPath}: ${cause.message}`),
        ),
      );
  }).pipe(Effect.onError(() => fs.remove(tempPath).pipe(Effect.orElseSucceed(() => undefined))));
};

/**
 * Builds the {@link LegacyStartContainerSpec.preStartArchives} entry that restores a
 * {@link legacyExportPgDataTar} tar into a container between `docker create` and `docker start`.
 * `containerPath` is PGDATA's PARENT, not PGDATA itself — see {@link LEGACY_PGDATA_PARENT_PATH}'s
 * own doc comment for why.
 */
export const legacyPgDataRestoreArchive = (
  fs: FileSystem.FileSystem,
  tarPath: string,
): NonNullable<LegacyStartContainerSpec["preStartArchives"]>[number] => ({
  containerPath: LEGACY_PGDATA_PARENT_PATH,
  tar: fs.stream(tarPath),
});
