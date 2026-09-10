/**
 * Generic PGDATA snapshot/restore primitives, reusable beyond `shadow-cache.ts` for savepointing
 * any local Postgres container.
 *
 * The container must be stopped before {@link exportPgDataTar} runs — a snapshot of a running
 * Postgres data directory is not consistent to copy; callers own the stop/start.
 * {@link pgDataRestoreArchive} must be delivered as a tar stream via `docker cp -`, never a
 * directory copy, since a directory copy resets file ownership and Postgres refuses to start.
 *
 * TODO(hot-save): support `frozen` (`docker pause`/copy/unpause) and `online`
 * (`pg_backup_start`/`pg_backup_stop`) consistency modes for a live-stack savepoint feature that
 * can't afford downtime.
 */

import { Effect, Option, Stream, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { collectText, describeContainerCliFailure, spawnContainerCli } from "../container-cli.ts";
import { dockerCopyArchiveIntoContainer } from "./container-lifecycle.ts";
import type { StartContainerSpec } from "./docker-create-args.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * PGDATA path inside every `supabase/postgres` image. Hardcoded rather than read from the
 * container's own `PGDATA` env, since the tar layout depends on this exact value.
 */
export const PGDATA_PATH = "/var/lib/postgresql/data";

/**
 * `docker cp` unpacks an archive's members relative to `dest`, and the export tar has `data/` as
 * its own top-level member, so the restore target must be PGDATA's parent. A POSIX constant, not
 * `path.dirname`, since this is a container path.
 */
export const PGDATA_PARENT_PATH = "/var/lib/postgresql";

/**
 * PGDATA's own directory name — `docker cp <id>:<dir> -` names its members after the source
 * basename, so `data/` is the export tar's top-level entry.
 */
const PGDATA_DIR_NAME = PGDATA_PATH.slice(PGDATA_PARENT_PATH.length + 1);

/**
 * Proves an archive carries an exported cluster: every Postgres data directory has a
 * `PG_VERSION` file at its root, written by `initdb`. Weaker than what a cache key promises —
 * see {@link PGDATA_BASELINE_MARKER_ENTRY}.
 */
export const PGDATA_CLUSTER_ENTRY = `${PGDATA_DIR_NAME}/PG_VERSION`;

/**
 * A file this module writes into PGDATA's root ({@link stampPgDataBaselineMarker}) as the last
 * step before export. Postgres ignores unknown regular files there, so a restored container
 * simply carries it along at the cost of one 512-byte tar member.
 *
 * Uppercase so it sorts near `PG_VERSION` at the front of the archive when `docker cp` tars the
 * directory in sorted order — a scan hint only; {@link validatePgDataArchive} is correct at any
 * position.
 */
export const PGDATA_BASELINE_MARKER_NAME = "SUPABASE_BASELINE";

/**
 * The marker's tar entry — what {@link validatePgDataArchive} looks for to confirm a snapshot is
 * the platform baseline this key promises, not merely a PostgreSQL cluster.
 *
 * {@link stampPgDataBaselineMarker} writes it only after the caller's baseline completes and
 * immediately before the copy-out, so an archive produced earlier — or a hand-placed bare PGDATA
 * tar — cannot carry it and is rejected before anything is restored.
 */
export const PGDATA_BASELINE_MARKER_ENTRY = `${PGDATA_DIR_NAME}/${PGDATA_BASELINE_MARKER_NAME}`;

/**
 * The marker's content is the cache key the archive is published under (also its filename's
 * stem), so a snapshot copied or renamed over another key's cache file fails validation instead
 * of silently restoring the wrong baseline. Stamped with a trailing newline so the file stays
 * plain text, and both halves of the check go through this one function.
 */
export const pgDataBaselineMarkerContent = (key: string): string => `${key}\n`;

/** Every entry {@link validatePgDataArchive} requires of a restorable snapshot. */
export const PGDATA_REQUIRED_ENTRIES: ReadonlyArray<string> = [
  PGDATA_CLUSTER_ENTRY,
  PGDATA_BASELINE_MARKER_ENTRY,
];

/**
 * Internal "snapshot could not be produced" signal, not a `Data.TaggedError`: callers of
 * {@link exportPgDataTar} each decide how to degrade (the shadow baseline cache warns and
 * continues uncached), so this must not be mistaken for a CLI-facing error.
 */
export interface PgDataSnapshotUnavailable {
  readonly reason: string;
}

const pgDataSnapshotUnavailable = (reason: string): PgDataSnapshotUnavailable => ({
  reason,
});

/**
 * The one-member tar {@link stampPgDataBaselineMarker} pushes into the container:
 * `SUPABASE_BASELINE`, relative to PGDATA, carrying {@link pgDataBaselineMarkerContent}'s
 * token for `key`. Exported so a unit test can round-trip it through this module's own scanner.
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
 * Writes {@link PGDATA_BASELINE_MARKER_ENTRY} into the container's PGDATA so the following
 * export carries it, letting {@link validatePgDataArchive} tell a completed baseline for `key`
 * apart from any other cluster (including a different key's snapshot copied over this cache
 * file). Delivered as a stdin tar via `docker cp -` so it needs no daemon-visible host path.
 * Must run as the last mutation before {@link exportPgDataTar}.
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
 * Streams `docker cp <containerId>:${PGDATA_PATH} -` to a temp file next to `tarPath` and
 * `rename`s it into place, so a partially written tar is never visible under the final name;
 * any failure removes the temp file. The container must already be stopped (callers own the
 * stop/start), and the temp name is scoped by pid alone, so concurrent exports to the same
 * `tarPath` must be externally serialized (`shadow-cache.ts` holds `shadowExportMutex`).
 */
export const exportPgDataTar = (
  spawner: Spawner,
  containerId: string,
  fs: FileSystem.FileSystem,
  tarPath: string,
): Effect.Effect<void, PgDataSnapshotUnavailable> => {
  const tempPath = `${tarPath}.${process.pid}.partial`;
  return Effect.gen(function* () {
    // Clears a leftover temp file (crashed predecessor or pre-created by another process) so the
    // exclusive-create below starts from a fresh inode.
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
            // 0o600: the archive contains vault secrets, the JWT secret, and role password
            // hashes, so it must not be group/world-readable; `rename` preserves the mode.
            // `wx` (O_EXCL) avoids inheriting a pre-created file's more permissive mode; if the
            // path was recreated in the race window, this degrades to an uncached run rather
            // than a world-readable tar.
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

/** POSIX tar's fixed block size: headers, file content, and the end marker are all multiples of it. */
const TAR_BLOCK_SIZE = 512;

const TAR_NO_BYTES = new Uint8Array(0);

const tarDecoder = new TextDecoder();

/**
 * Cap on how much of a captured entry {@link scanTarChunkForEntries} buffers. An oversized
 * entry (larger than any marker this module writes) is left uncaptured rather than trusted on
 * an untrusted archive's size field.
 */
const TAR_CAPTURE_MAX_BYTES = 1024;

/**
 * {@link scanTarChunkForEntries}'s carry-over state for resuming a header walk across chunk
 * boundaries. `carry` holds a header block split across chunks (always `< 512` bytes); `skip`
 * counts file-content bytes still to step over without buffering.
 */
export interface TarScanState {
  readonly carry: Uint8Array;
  readonly skip: number;
  /** Consecutive all-zero blocks seen; two in a row is tar's end-of-archive marker. */
  readonly zeroBlocks: number;
  /**
   * Required entries not yet seen. What remains when the scan settles is what the archive is
   * missing.
   */
  readonly missing: ReadonlySet<string>;
  readonly ended: boolean;
  /** A block that is neither zero nor a checksum-valid header: not a tar (or a truncated one). */
  readonly malformed: boolean;
  /**
   * The one entry whose content the walk reads instead of stepping over — the baseline marker,
   * whose bytes say which key the archive belongs to. `undefined` for a presence-only walk.
   */
  readonly captureEntry: string | undefined;
  /**
   * {@link captureEntry}'s content bytes. `undefined` until its header is seen, or still
   * `undefined` afterwards if the entry was too large to capture
   * ({@link TAR_CAPTURE_MAX_BYTES}) — either way treated as "no content to compare against".
   */
  readonly captured: Uint8Array | undefined;
  /** Content bytes of {@link captureEntry} still to be captured; `0` once complete or not capturing. */
  readonly capturePending: number;
}

/**
 * A fresh walk requiring every entry in `required`, capturing `captureEntry`'s content along
 * the way when given (it must be one of `required`).
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
 * Tar's header checksum: the sum of all 512 bytes with the checksum field itself read as
 * spaces. Both the unsigned and historical signed summation are accepted, as every tar reader
 * does; this is what tells a genuine header apart from arbitrary bytes.
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
 * Folds one stream chunk into a tar header walk for entries still in `state.missing`,
 * capturing `state.captureEntry`'s content if given. Non-captured content is stepped over by
 * byte count, bounding memory to one partial header block plus at most
 * {@link TAR_CAPTURE_MAX_BYTES}. Stops at the first required entry found (with capture
 * complete), the end-of-archive marker, or an invalid header block.
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
   * Appends the leading `capturePending` bytes of a content run. `capturePending` never exceeds
   * what remains of the capture entry's content, so this is correct whether the run is carried
   * over from the previous chunk or fresh in this one.
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
    // Arm the capture only on the entry's first occurrence (`wasMissing`), so a later duplicate
    // member cannot overwrite it. An oversized entry is left uncaptured; see {@link TAR_CAPTURE_MAX_BYTES}.
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
 * The two ways {@link validatePgDataArchive} can reject an archive for `key`. Both implicate
 * the file, not the infrastructure, so a caller can safely act on either by discarding it.
 */
export type PgDataArchiveProblem =
  /** The header stream never carried one of {@link PGDATA_REQUIRED_ENTRIES}. */
  | { readonly _tag: "missing-entries"; readonly entries: ReadonlyArray<string> }
  /**
   * Every entry is there, but the marker vouches for a different key than the one this archive
   * is stored under. `found` is the marker's own token (trimmed), or `undefined` when it
   * carried none that could be read.
   */
  | { readonly _tag: "wrong-key"; readonly expected: string; readonly found: string | undefined };

/**
 * Whether `tarPath` is a snapshot that may be restored as `key`'s baseline: `Option.none()` when
 * it may, otherwise the reason it may not.
 *
 * Guards against three silent-failure levels: no cluster at all (missing `PG_VERSION`), a bare
 * PGDATA never baselined (missing marker), and a different key's baseline copied over this
 * cache file (marker content mismatch). Reads the file locally with O(1) memory.
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
  // Trimmed for the report only; the comparison above uses the exact canonical form, so a
  // whitespace-padded marker is still a mismatch.
  return Option.some({ _tag: "wrong-key", expected: key, found: stamped?.trim() });
};

/**
 * Builds the {@link StartContainerSpec.preStartArchives} entry that restores an
 * {@link exportPgDataTar} tar into a container between `docker create` and `docker start`.
 * `containerPath` is PGDATA's parent, not PGDATA itself; see {@link PGDATA_PARENT_PATH}.
 */
export const pgDataRestoreArchive = (
  fs: FileSystem.FileSystem,
  tarPath: string,
): NonNullable<StartContainerSpec["preStartArchives"]>[number] => ({
  containerPath: PGDATA_PARENT_PATH,
  tar: fs.stream(tarPath),
});
