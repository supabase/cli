/**
 * Generic PGDATA snapshot/restore primitives — container-agnostic on purpose. `shadow-cache.ts`
 * is the only caller today, but nothing here assumes "shadow": these are the building blocks for
 * savepointing ANY local Postgres container and restoring it into a fresh one — the shadow's
 * disk-level baseline cache today, a future save/restore for the long-running
 * `supabase_db_<project>` stack container tomorrow.
 *
 * **Coherence contract:** the container must be STOPPED before {@link exportPgDataTar}
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
 * **Ownership caveat:** the restore side ({@link pgDataRestoreArchive}) MUST be delivered as
 * a tar stream unpacked via `docker cp - <id>:<path>`, never a directory copy — a directory copy
 * resets ownership to the extracting user (root) and Postgres refuses to start on a data directory
 * it does not own, whereas the tar-stream form preserves each member's uid/gid verbatim.
 *
 * The artifact is a plain file, so it fits a future NATIVE (non-Docker) Postgres service just as
 * well — nothing about the format is container-specific.
 */

import { Effect, Option, Stream, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { collectText, describeContainerCliFailure, spawnContainerCli } from "../container-cli.ts";
import { dockerCopyArchiveIntoContainer } from "./container-lifecycle.ts";
import type { StartContainerSpec } from "./docker-create-args.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * `PGDATA` in every `supabase/postgres` image — the directory {@link exportPgDataTar}
 * exports and {@link pgDataRestoreArchive} restores. Hardcoded rather than read from the
 * container's own `PGDATA` env: the entrypoint scripts this codebase generates
 * (`postgres.service.ts`) never override it, and the value is part of the tar's own layout, so a
 * mismatch has to be a deliberate change here.
 */
export const PGDATA_PATH = "/var/lib/postgresql/data";

/**
 * `docker cp - <id>:<dest>` unpacks the archive's members RELATIVE to `dest`, and
 * {@link PGDATA_PATH}'s export tar has `data/` as its own top-level member, so the restore
 * target is PGDATA's parent. A POSIX constant, not `path.dirname` — this is a container path and
 * must not follow the host's separator.
 */
export const PGDATA_PARENT_PATH = "/var/lib/postgresql";

// ---------------------------------------------------------------------------
// What a valid snapshot must contain
// ---------------------------------------------------------------------------

/**
 * PGDATA's own directory name — `docker cp <id>:<dir> -` names its members after the source
 * BASENAME, so `data/` is the export tar's top-level entry (see {@link PGDATA_PARENT_PATH}).
 */
const PGDATA_DIR_NAME = PGDATA_PATH.slice(PGDATA_PARENT_PATH.length + 1);

/**
 * The entry whose presence proves an archive really carries an exported cluster: every Postgres
 * data directory has a `PG_VERSION` file at its root, and `initdb` writes it first. An archive that
 * unpacks cleanly but lacks it is the corruption a restore cannot otherwise notice.
 *
 * On its own it proves only "*a* PostgreSQL cluster", which is strictly weaker than what a cache
 * key promises — hence {@link PGDATA_BASELINE_MARKER_ENTRY}.
 */
export const PGDATA_CLUSTER_ENTRY = `${PGDATA_DIR_NAME}/PG_VERSION`;

/**
 * A file this module writes into PGDATA's ROOT ({@link stampPgDataBaselineMarker}) as the
 * last step before the export copies the directory out. Postgres ignores unknown regular files at
 * the data directory's root (`pg_upgrade` and friends routinely leave some there), and a restored
 * container simply carries it along, so the cost of the stamp is one 512-byte tar member.
 *
 * SCREAMING_SNAKE on purpose, and not by taste: `docker cp` tars a directory through Go's
 * `filepath.Walk`, which visits each level in sorted order, so an uppercase root file lands
 * immediately next to `PG_VERSION` — near the front of a ~90MB archive rather than behind every
 * `base/` page. That is a PERFORMANCE hint for {@link validatePgDataArchive} only:
 * the scan is correct at any position, and settles late (not wrongly) if a Docker release ever
 * reorders its walk.
 */
export const PGDATA_BASELINE_MARKER_NAME = "SUPABASE_BASELINE";

/**
 * The marker's tar entry — what {@link validatePgDataArchive} looks for, and the reason a
 * cached snapshot means "the Supabase platform baseline this key promises" rather than merely "a
 * PostgreSQL cluster".
 *
 * Its whole value is WHEN it is written: {@link stampPgDataBaselineMarker} is called from the
 * export step alone, after the caller's own baseline has completed and immediately before the
 * copy-out. So an archive produced before the baseline ran — a wiring regression that moves the
 * snapshot earlier, or a hand-placed bare PGDATA tar dropped into the cache directory — cannot
 * carry it, and is rejected before anything is restored.
 */
export const PGDATA_BASELINE_MARKER_ENTRY = `${PGDATA_DIR_NAME}/${PGDATA_BASELINE_MARKER_NAME}`;

/**
 * The marker's CONTENT: the caller's own identity token for what the snapshot carries — for the
 * shadow baseline cache, the cache key the archive is published under, which is also its
 * filename's stem (`shadowBaselineTarFileName`, `shadow-cache.ts`).
 *
 * Presence alone is strictly weaker than a snapshot's own filename claims: a perfectly valid
 * archive COPIED or RENAMED over another key's cache file passes a name-only check and warm-restores
 * a baseline built from different roles/vault values/service versions. Binding the marker to the
 * key — stamped at export, compared at validation ({@link validatePgDataArchive}) — is what
 * makes an archive vouch for the filename it is stored under, not merely for "some baseline".
 *
 * The trailing newline is the canonical form on BOTH sides: it makes the stamped file a normal
 * one-line text file (`cat`-able while debugging a cache directory) and both halves of the contract
 * go through this one function, so the two can never drift.
 */
export const pgDataBaselineMarkerContent = (key: string): string => `${key}\n`;

/** Every entry {@link validatePgDataArchive} requires of a restorable snapshot. */
export const PGDATA_REQUIRED_ENTRIES: ReadonlyArray<string> = [
  PGDATA_CLUSTER_ENTRY,
  PGDATA_BASELINE_MARKER_ENTRY,
];

/**
 * Internal-only "the snapshot could not be produced" signal — deliberately NOT a
 * `Data.TaggedError`: every caller of {@link exportPgDataTar} decides for itself how to
 * degrade (the shadow baseline cache warns and continues uncached), so this must not be mistaken
 * for a CLI-facing error.
 */
export interface PgDataSnapshotUnavailable {
  readonly reason: string;
}

const pgDataSnapshotUnavailable = (reason: string): PgDataSnapshotUnavailable => ({
  reason,
});

/**
 * The one-member tar {@link stampPgDataBaselineMarker} pushes into the container:
 * `SUPABASE_BASELINE` relative to the `docker cp` destination, which is PGDATA itself, carrying
 * {@link pgDataBaselineMarkerContent}'s token for `key`.
 *
 * Exported for the unit test that round-trips it through this module's own scanner — the stamp and
 * the check have to agree on the entry name AND on the content encoding, and nothing else proves
 * that they do.
 */
export const pgDataBaselineMarkerTar = (
  key: string,
): Effect.Effect<Uint8Array, PgDataSnapshotUnavailable> =>
  Effect.tryPromise({
    try: () =>
      new Bun.Archive({
        [PGDATA_BASELINE_MARKER_NAME]: pgDataBaselineMarkerContent(key),
      }).bytes(),
    catch: (cause) =>
      pgDataSnapshotUnavailable(
        `failed to build the baseline marker archive: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });

/**
 * Writes {@link PGDATA_BASELINE_MARKER_ENTRY} into the container's PGDATA, so the export
 * that follows carries it and {@link validatePgDataArchive} can tell a snapshot of a
 * COMPLETED baseline for `key` apart from any other cluster — including a valid snapshot of a
 * DIFFERENT key that was copied over this key's cache file.
 *
 * Delivered as a stdin tar through `docker cp -`, the same form the restore side uses
 * (`extractPreStartArchiveIntoContainer`, `container-lifecycle.ts`) and for the same reason:
 * it needs no daemon-visible host path, so it works against local, remote-context, and confined
 * Docker clients alike. `docker cp` into a STOPPED container is fully supported — which is exactly
 * the state this module's coherence contract already requires of the export.
 *
 * The caller owns the ORDERING that gives the marker its meaning: this must be the last mutation
 * before {@link exportPgDataTar}, and must run only once whatever the snapshot is supposed to
 * capture is genuinely in place.
 */
export const stampPgDataBaselineMarker = (
  spawner: Spawner,
  containerId: string,
  key: string,
): Effect.Effect<void, PgDataSnapshotUnavailable> =>
  Effect.gen(function* () {
    const tar = yield* pgDataBaselineMarkerTar(key);
    yield* dockerCopyArchiveIntoContainer(spawner, tar, `${containerId}:${PGDATA_PATH}`, (detail) =>
      pgDataSnapshotUnavailable(`failed to stamp ${PGDATA_BASELINE_MARKER_ENTRY}: ${detail}`),
    );
  });

/**
 * Streams `docker cp <containerId>:${PGDATA_PATH} -`'s tar straight to a temp file next to
 * `tarPath` and `rename`s it into place. The stream never lands in memory: the child's stdout is
 * piped into `FileSystem.sink`, so a large snapshot costs one buffer's worth of heap.
 *
 * The container must already be STOPPED (see this module's own header) — the caller owns the
 * stop/start around this call. The `rename` is the LAST step and is what publishes the entry: a
 * partially written tar must never be observable under the final name. Any failure removes the
 * temp file; nothing is left behind for a later run to find.
 *
 * The temp name is scoped by pid alone, so two exports to the same `tarPath` are safe across
 * processes but not within one: a same-process concurrent writer's pre-clean would unlink this
 * writer's live temp file, and the eventual `rename` could publish the other writer's
 * half-written bytes. Callers own that serialization — `shadow-cache.ts` holds
 * `shadowExportMutex` around every call.
 */
export const exportPgDataTar = (
  spawner: Spawner,
  containerId: string,
  fs: FileSystem.FileSystem,
  tarPath: string,
): Effect.Effect<void, PgDataSnapshotUnavailable> => {
  const tempPath = `${tarPath}.${process.pid}.partial`;
  return Effect.gen(function* () {
    // Clear any pre-existing file at the temp path (a crashed same-pid predecessor, or an
    // adversarially pre-created one on a shared host) so the exclusive-create below starts from
    // a genuinely fresh inode — see the sink's own comment.
    yield* fs.remove(tempPath).pipe(Effect.orElseSucceed(() => undefined));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawnContainerCli(
          spawner,
          ["cp", `${containerId}:${PGDATA_PATH}`, "-"],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        ).pipe(
          Effect.mapError((cause) =>
            pgDataSnapshotUnavailable(
              `failed to export ${PGDATA_PATH}: ${describeContainerCliFailure(cause)}`,
            ),
          ),
        );
        // stdout is consumed concurrently with awaiting the exit code, not after it: an
        // unread pipe would block `docker cp` long before it finished writing the archive.
        const [exitCode, , stderr] = yield* Effect.all(
          [
            child.exitCode.pipe(Effect.map(Number)),
            // `0o600`: the archive is a full PGDATA — vault secret values, the JWT secret, and
            // role password hashes are all in its pages — so it must not be group/world-readable
            // on a shared host. `rename` preserves the mode, so the published tar inherits it.
            // `wx` (O_EXCL), not `w`: a plain truncating open would inherit an attacker-
            // PRE-CREATED file's permissive mode instead of applying `mode` (which only governs
            // creation). With the best-effort remove above, `wx` only ever fails if someone
            // recreated the path in the race window — and that failure degrades to an uncached
            // run, never to a world-readable tar.
            Stream.run(child.stdout, fs.sink(tempPath, { flag: "wx", mode: 0o600 })),
            collectText(child.stderr),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError((cause) =>
            pgDataSnapshotUnavailable(
              `failed to export ${PGDATA_PATH}: ${describeContainerCliFailure(cause)}`,
            ),
          ),
        );
        if (exitCode !== 0) {
          const message = stderr.trim();
          return yield* Effect.fail(
            pgDataSnapshotUnavailable(
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
          pgDataSnapshotUnavailable(`failed to publish ${tarPath}: ${cause.message}`),
        ),
      );
  }).pipe(Effect.onError(() => fs.remove(tempPath).pipe(Effect.orElseSucceed(() => undefined))));
};

// ---------------------------------------------------------------------------
// Archive validation
// ---------------------------------------------------------------------------

/** POSIX tar's fixed block size: headers, file content, and the end marker are all multiples of it. */
const TAR_BLOCK_SIZE = 512;

const TAR_NO_BYTES = new Uint8Array(0);

const tarDecoder = new TextDecoder();

/**
 * The most content {@link scanTarChunkForEntries} will ever buffer for `captureEntry`. The
 * only entry any caller captures is the baseline marker, whose content is one short identity token,
 * so a larger member cannot be a marker this module wrote: it is left UNCAPTURED (`captured` stays
 * `undefined`, which every reader treats as "does not match"), rather than being read into memory
 * on the word of an untrusted archive's own size field. Keeps the scan's O(1) memory property
 * intact whatever a hand-placed tar in the cache directory claims.
 */
const TAR_CAPTURE_MAX_BYTES = 1024;

/**
 * {@link scanTarChunkForEntries}'s carry-over state — everything needed to resume a header
 * walk at an arbitrary chunk boundary, and nothing else. `carry` holds the bytes of a header block
 * a chunk ended in the middle of (always `< 512`); `skip` counts the file-content bytes still to be
 * STEPPED OVER without buffering, which is what keeps a ~90MB archive off the heap.
 */
export interface TarScanState {
  readonly carry: Uint8Array;
  readonly skip: number;
  /** Consecutive all-zero blocks seen; two in a row is tar's end-of-archive marker. */
  readonly zeroBlocks: number;
  /**
   * The required entries not seen yet. Empty means every one of them was found; whatever is left
   * once the scan settles is what the archive is missing, which is what the caller reports.
   */
  readonly missing: ReadonlySet<string>;
  readonly ended: boolean;
  /** A block that is neither zero nor a checksum-valid header: not a tar (or a truncated one). */
  readonly malformed: boolean;
  /**
   * The one entry whose CONTENT the walk reads rather than steps over — the baseline marker, whose
   * bytes say which key the archive belongs to. `undefined` for a presence-only walk.
   */
  readonly captureEntry: string | undefined;
  /**
   * {@link captureEntry}'s content bytes. `undefined` until its header is seen, and STILL undefined
   * afterwards when the entry was too large to capture ({@link TAR_CAPTURE_MAX_BYTES}) —
   * both mean "no content to compare against", which is the safe verdict either way.
   */
  readonly captured: Uint8Array | undefined;
  /** Content bytes of {@link captureEntry} still to be captured; `0` once complete or not capturing. */
  readonly capturePending: number;
}

/**
 * A fresh walk looking for `required` — every entry of which must appear for the scan to pass —
 * capturing `captureEntry`'s content along the way when given (it must be one of `required`, so
 * that "found everything" also means "the captured entry's header was seen").
 */
export const initialTarScanState = (
  required: Iterable<string>,
  captureEntry?: string,
): TarScanState => ({
  carry: TAR_NO_BYTES,
  skip: 0,
  zeroBlocks: 0,
  missing: new Set(required),
  ended: false,
  malformed: false,
  captureEntry,
  captured: undefined,
  capturePending: 0,
});

/** Whether every required entry has been seen AND its captured content (if any) is complete. */
export const tarScanFound = (state: TarScanState): boolean =>
  state.missing.size === 0 && state.capturePending === 0;

/** Whether the scan has reached a verdict — nothing later in the archive can change it. */
export const tarScanSettled = (state: TarScanState): boolean =>
  tarScanFound(state) || state.ended || state.malformed;

/** {@link TarScanState.captured} decoded, or `undefined` when there is nothing to compare. */
export const tarScanCapturedText = (state: TarScanState): string | undefined =>
  state.captured === undefined ? undefined : tarDecoder.decode(state.captured);

/** A NUL-terminated text field of a tar header block. */
const tarTextField = (block: Uint8Array, offset: number, length: number): string => {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return tarDecoder.decode(end === -1 ? raw : raw.subarray(0, end));
};

/**
 * A numeric header field: NUL/space-padded octal, or GNU's base-256 form (high bit of the first
 * byte) for sizes past what 11 octal digits can hold. `undefined` when neither parses.
 */
const tarNumericField = (block: Uint8Array, offset: number, length: number): number | undefined => {
  const first = block[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let index = offset + 1; index < offset + length; index += 1) {
      value = value * 256 + (block[index] ?? 0);
    }
    return value;
  }
  const text = tarTextField(block, offset, length).trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/u.test(text)) return undefined;
  return Number.parseInt(text, 8);
};

/**
 * Tar's own integrity check on a header block: the stored checksum is the sum of all 512 bytes
 * with the checksum field itself read as spaces. Both the unsigned and the (historical) signed
 * summation are accepted, as every tar reader does. This is what tells a genuine header apart from
 * arbitrary bytes, so a non-tar file cannot be walked as if it were one.
 */
const tarChecksumValid = (block: Uint8Array): boolean => {
  const stored = tarNumericField(block, 148, 8);
  if (stored === undefined) return false;
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
};

/** The header's full member path: ustar's `prefix` field rejoined, with a leading `./` dropped. */
const tarEntryName = (block: Uint8Array): string => {
  const name = tarTextField(block, 0, 100);
  const prefix = tarTextField(block, 345, 155);
  const joined = prefix.length > 0 ? `${prefix}/${name}` : name;
  return joined.startsWith("./") ? joined.slice(2) : joined;
};

const tarBlockIsZero = (block: Uint8Array): boolean => block.every((byte) => byte === 0);

/**
 * Folds one stream chunk into a tar HEADER walk looking for every entry still in `state.missing`,
 * capturing `state.captureEntry`'s content if it has one. Pure and chunk-boundary-agnostic: every
 * other member's content is stepped over by byte count rather than buffered, so the whole scan
 * costs one partial header block plus (at most)
 * {@link TAR_CAPTURE_MAX_BYTES} of memory no matter how large the archive is. Stops (and
 * stays stopped) at the first of: the last required entry found (with its capture complete), the
 * end-of-archive marker, or a block that is not a valid header.
 */
export const scanTarChunkForEntries = (state: TarScanState, chunk: Uint8Array): TarScanState => {
  if (tarScanSettled(state)) return state;
  let carry = state.carry;
  let skip = state.skip;
  let zeroBlocks = state.zeroBlocks;
  let missing = state.missing;
  let captured = state.captured;
  let capturePending = state.capturePending;
  const { captureEntry } = state;
  /**
   * Appends the leading `capturePending` bytes of a content run being consumed. Content bytes are
   * always consumed front-to-back, and `capturePending` never exceeds what is left of the capture
   * entry's own content, so this is correct whether the run is the tail carried over from the
   * previous chunk or a fresh member's content in this one.
   */
  const takeCapture = (bytes: Uint8Array): void => {
    if (capturePending <= 0 || captured === undefined) return;
    const take = Math.min(capturePending, bytes.length);
    const merged = new Uint8Array(captured.length + take);
    merged.set(captured);
    merged.set(bytes.subarray(0, take), captured.length);
    captured = merged;
    capturePending -= take;
  };
  // A verdict keeps `missing`/`captured` (they are the report) and drops the walk's resumption state.
  const settle = (verdict: Pick<TarScanState, "ended" | "malformed">): TarScanState => ({
    carry: TAR_NO_BYTES,
    skip: 0,
    zeroBlocks: 0,
    missing,
    captureEntry,
    captured,
    capturePending,
    ...verdict,
  });
  // Content bytes carried over from the previous chunk come first — they are not headers.
  let offset = Math.min(skip, chunk.length);
  takeCapture(chunk.subarray(0, offset));
  skip -= offset;
  // The capture may have been the only thing outstanding when the previous chunk ran out.
  if (missing.size === 0 && capturePending === 0) return settle({ ended: false, malformed: false });
  while (offset < chunk.length) {
    const available = chunk.length - offset;
    let block: Uint8Array;
    if (carry.length > 0) {
      const take = Math.min(TAR_BLOCK_SIZE - carry.length, available);
      const merged = new Uint8Array(carry.length + take);
      merged.set(carry);
      merged.set(chunk.subarray(offset, offset + take), carry.length);
      offset += take;
      if (merged.length < TAR_BLOCK_SIZE) {
        carry = merged;
        break;
      }
      carry = TAR_NO_BYTES;
      block = merged;
    } else if (available < TAR_BLOCK_SIZE) {
      carry = chunk.slice(offset);
      break;
    } else {
      block = chunk.subarray(offset, offset + TAR_BLOCK_SIZE);
      offset += TAR_BLOCK_SIZE;
    }

    if (tarBlockIsZero(block)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) return settle({ ended: true, malformed: false });
      continue;
    }
    zeroBlocks = 0;
    if (!tarChecksumValid(block)) {
      return settle({ ended: false, malformed: true });
    }
    const name = tarEntryName(block);
    const wasMissing = missing.has(name);
    if (wasMissing) {
      const remaining = new Set(missing);
      remaining.delete(name);
      missing = remaining;
    }
    const size = tarNumericField(block, 124, 12);
    if (size === undefined || size < 0) {
      return settle({ ended: false, malformed: true });
    }
    // Arm the capture on the capture entry's FIRST occurrence only (`wasMissing`), so a duplicate
    // member later in the archive cannot overwrite what the real one said. An oversized entry is
    // left uncaptured — see {@link TAR_CAPTURE_MAX_BYTES}.
    if (wasMissing && name === captureEntry && size <= TAR_CAPTURE_MAX_BYTES) {
      captured = TAR_NO_BYTES;
      capturePending = size;
    }
    // Content is padded up to the next block boundary; directories and links carry size 0.
    const content = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    const stepped = Math.min(content, chunk.length - offset);
    takeCapture(chunk.subarray(offset, offset + stepped));
    offset += stepped;
    skip = content - stepped;
    // Only now, with the capture (if any) armed and fed: settling at the header would have
    // discarded the very bytes the marker check needs.
    if (missing.size === 0 && capturePending === 0) {
      return settle({ ended: false, malformed: false });
    }
  }
  return {
    carry,
    skip,
    zeroBlocks,
    missing,
    ended: false,
    malformed: false,
    captureEntry,
    captured,
    capturePending,
  };
};

/**
 * Why an archive at `tarPath` must not be restored under `key` — the two distinguishable ways
 * {@link validatePgDataArchive} can reject one. Both implicate the FILE, never the
 * infrastructure, so both are safe for a caller to act on by discarding it.
 */
export type PgDataArchiveProblem =
  /** The header stream never carried one of {@link PGDATA_REQUIRED_ENTRIES}. */
  | { readonly _tag: "missing-entries"; readonly entries: ReadonlyArray<string> }
  /**
   * Every entry is there, but the marker vouches for a DIFFERENT key than the one this archive is
   * stored under. `found` is the marker's own token (trimmed), or `undefined` when it carried none
   * that could be read (an oversized or truncated marker member).
   */
  | { readonly _tag: "wrong-key"; readonly expected: string; readonly found: string | undefined };

/**
 * Whether `tarPath` is a snapshot that may be restored as `key`'s baseline — `Option.none()` when
 * it is, the reason it is not otherwise.
 *
 * Three failures, each invisible to the restore itself. Without `PG_VERSION`, an archive that is
 * syntactically fine but carries no cluster (an EMPTY tar qualifies) restores SILENTLY:
 * `docker cp -` extracts nothing, the Postgres entrypoint finds an empty PGDATA and runs a fresh
 * `initdb`, readiness passes, and the caller is handed a bare cluster it believes carries the
 * platform baseline. Without the baseline marker, that same silent-success shape survives one level
 * up: a REAL but bare PGDATA tar (dropped into the cache directory by hand, or produced by a future
 * regression that exports before the baseline runs) restores, starts, and answers — and only the
 * resulting diff would ever show it. And without the marker's CONTENT, it survives one level up
 * again: a genuine, fully baselined snapshot of ANOTHER key, copied or renamed over this key's
 * cache file, passes every name-only check while carrying different roles, vault values, and
 * service-version schema — see {@link pgDataBaselineMarkerContent}. Validating the header
 * stream up front is the only place any of the three is observable, so callers must check BEFORE
 * restoring.
 *
 * Reads the file locally — no Docker, no extraction — and stops as soon as both entries have been
 * seen and the marker's few bytes read; see {@link PGDATA_BASELINE_MARKER_NAME} for why that
 * is normally within the archive's first blocks. Even a full walk only parses HEADERS (every other
 * member's content is stepped over by byte count), so the cost is one sequential read with O(1)
 * memory. Only a genuine read failure fails; a valid tar that does not qualify simply reports why.
 */
export const validatePgDataArchive = (
  fs: FileSystem.FileSystem,
  tarPath: string,
  key: string,
): Effect.Effect<Option.Option<PgDataArchiveProblem>, PgDataSnapshotUnavailable> =>
  fs.stream(tarPath).pipe(
    Stream.mapAccum(
      () => initialTarScanState(PGDATA_REQUIRED_ENTRIES, PGDATA_BASELINE_MARKER_ENTRY),
      (state: TarScanState, chunk: Uint8Array) => {
        const next = scanTarChunkForEntries(state, chunk);
        return [next, [next]] as const;
      },
    ),
    Stream.takeUntil(tarScanSettled),
    Stream.runLast,
    // An empty file yields no chunks at all, so `None` means nothing was found: everything missing.
    Effect.map((last) =>
      Option.isSome(last)
        ? pgDataArchiveProblem(last.value, key)
        : Option.some<PgDataArchiveProblem>({
            _tag: "missing-entries",
            entries: PGDATA_REQUIRED_ENTRIES,
          }),
    ),
    Effect.mapError((cause) =>
      pgDataSnapshotUnavailable(`failed to read ${tarPath}: ${cause.message}`),
    ),
  );

/** {@link validatePgDataArchive}'s verdict, split out so it is pure and directly testable. */
const pgDataArchiveProblem = (
  state: TarScanState,
  key: string,
): Option.Option<PgDataArchiveProblem> => {
  const entries = PGDATA_REQUIRED_ENTRIES.filter((entry) => state.missing.has(entry));
  if (entries.length > 0) return Option.some({ _tag: "missing-entries", entries });
  const stamped = tarScanCapturedText(state);
  if (stamped === pgDataBaselineMarkerContent(key)) return Option.none();
  // Trimmed for the report only — the comparison above is on the exact canonical form, so a marker
  // padded with whitespace is a mismatch rather than something to normalize into a match.
  return Option.some({ _tag: "wrong-key", expected: key, found: stamped?.trim() });
};

/**
 * Builds the {@link StartContainerSpec.preStartArchives} entry that restores a
 * {@link exportPgDataTar} tar into a container between `docker create` and `docker start`.
 * `containerPath` is PGDATA's PARENT, not PGDATA itself — see {@link PGDATA_PARENT_PATH}'s
 * own doc comment for why.
 */
export const pgDataRestoreArchive = (
  fs: FileSystem.FileSystem,
  tarPath: string,
): NonNullable<StartContainerSpec["preStartArchives"]>[number] => ({
  containerPath: PGDATA_PARENT_PATH,
  tar: fs.stream(tarPath),
});
