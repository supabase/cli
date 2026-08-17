/**
 * The pure tar-header walk behind {@link legacyValidatePgDataArchive}'s pre-restore check.
 * Unit tests rather than integration ones because the interesting cases are all in the format
 * handling: chunk boundaries landing mid-header (or mid-MARKER-CONTENT), content that must be
 * stepped over rather than parsed, and bytes that are not a tar at all.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  LEGACY_PGDATA_BASELINE_MARKER_ENTRY,
  LEGACY_PGDATA_BASELINE_MARKER_NAME,
  LEGACY_PGDATA_CLUSTER_ENTRY,
  LEGACY_PGDATA_REQUIRED_ENTRIES,
  legacyInitialTarScanState,
  legacyPgDataBaselineMarkerContent,
  legacyPgDataBaselineMarkerTar,
  legacyScanTarChunkForEntries,
  legacyTarScanCapturedText,
  legacyTarScanFound,
  legacyTarScanSettled,
  type LegacyTarScanState,
} from "./pgdata-snapshot.ts";

const BLOCK = 512;

const encoder = new TextEncoder();

const tarBlock = (fields: ReadonlyArray<readonly [number, string]>): Uint8Array => {
  const block = new Uint8Array(BLOCK);
  for (const [offset, text] of fields) block.set(encoder.encode(text), offset);
  return block;
};

const octal = (value: number, width: number) => `${value.toString(8).padStart(width, "0")}\0`;

/** One ustar member: a checksummed header block plus its NUL-padded content blocks. */
const tarEntry = (name: string, content: string, typeFlag = "0"): Uint8Array => {
  const header = tarBlock([
    [0, name],
    [100, octal(0o600, 7)],
    [108, octal(0, 7)],
    [116, octal(0, 7)],
    [124, octal(content.length, 11)],
    [136, octal(0, 11)],
    [148, "        "],
    [156, typeFlag],
    [257, "ustar\0"],
    [263, "00"],
  ]);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(encoder.encode(`${octal(checksum, 6)} `), 148);
  const padded = new Uint8Array(Math.ceil(content.length / BLOCK) * BLOCK);
  padded.set(encoder.encode(content));
  const out = new Uint8Array(header.length + padded.length);
  out.set(header);
  out.set(padded, header.length);
  return out;
};

const TAR_END = new Uint8Array(2 * BLOCK);

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Feeds `tar` through the scanner in fixed-size chunks, stopping as the real stream would. */
const scan = (
  tar: Uint8Array,
  chunkSize: number,
  required: ReadonlyArray<string> = LEGACY_PGDATA_REQUIRED_ENTRIES,
  captureEntry: string | undefined = LEGACY_PGDATA_BASELINE_MARKER_ENTRY,
) => {
  let state: LegacyTarScanState = legacyInitialTarScanState(
    required,
    required.includes(captureEntry ?? "") ? captureEntry : undefined,
  );
  for (let offset = 0; offset < tar.length; offset += chunkSize) {
    state = legacyScanTarChunkForEntries(state, tar.subarray(offset, offset + chunkSize));
    if (legacyTarScanSettled(state)) break;
  }
  return {
    ...state,
    found: legacyTarScanFound(state),
    capturedText: legacyTarScanCapturedText(state),
  };
};

const KEY = "0011223344556677";

const MARKER_ENTRY = tarEntry(
  LEGACY_PGDATA_BASELINE_MARKER_ENTRY,
  legacyPgDataBaselineMarkerContent(KEY),
);

describe("legacyScanTarChunkForEntries", () => {
  const pgdataTar = concat(
    tarEntry("data/", "", "5"),
    tarEntry("data/postgresql.conf", "listen_addresses = '*'\n"),
    tarEntry(LEGACY_PGDATA_CLUSTER_ENTRY, "17\n"),
    MARKER_ENTRY,
    TAR_END,
  );

  it("finds every required entry regardless of where the chunk boundaries fall", () => {
    // 7 and 513 both split header blocks; the required entries are the last two members, behind a
    // directory and a file whose content must be stepped over rather than mistaken for a header.
    // The marker's own CONTENT is read rather than stepped over, so those same boundaries also
    // land mid-token — the capture has to survive being fed one byte at a time.
    for (const chunkSize of [1, 7, 100, 512, 513, 4096, pgdataTar.length]) {
      const state = scan(pgdataTar, chunkSize);
      expect(state.found, `chunk size ${chunkSize}`).toBe(true);
      expect(state.malformed).toBe(false);
      expect(state.capturedText, `chunk size ${chunkSize}`).toBe(
        legacyPgDataBaselineMarkerContent(KEY),
      );
    }
  });

  it("captures the marker's own key, not a same-named entry's, and not an oversized one", () => {
    // The whole point of the content: two archives with identical member LISTS, telling apart the
    // key each one actually vouches for.
    const other = concat(
      tarEntry("data/", "", "5"),
      tarEntry(LEGACY_PGDATA_CLUSTER_ENTRY, "17\n"),
      tarEntry(
        LEGACY_PGDATA_BASELINE_MARKER_ENTRY,
        legacyPgDataBaselineMarkerContent("ffffffff00000000"),
      ),
      TAR_END,
    );
    expect(scan(other, 512).found).toBe(true);
    expect(scan(other, 512).capturedText).toBe("ffffffff00000000\n");

    // A marker member larger than the cap is left UNCAPTURED rather than buffered on the say-so of
    // an untrusted archive's own size field — "no content" is the safe verdict, never a match.
    const oversized = concat(
      tarEntry(LEGACY_PGDATA_CLUSTER_ENTRY, "17\n"),
      tarEntry(LEGACY_PGDATA_BASELINE_MARKER_ENTRY, "x".repeat(2048)),
      TAR_END,
    );
    const state = scan(oversized, 512);
    expect(state.found).toBe(true);
    expect(state.capturedText).toBeUndefined();
  });

  it("stops at the last required entry without walking the rest of the archive", () => {
    // Everything after them is garbage: reaching it would settle `malformed` instead.
    const trailing = concat(
      tarEntry(LEGACY_PGDATA_CLUSTER_ENTRY, "17\n"),
      MARKER_ENTRY,
      encoder.encode("x".repeat(2048)),
    );
    expect(scan(trailing, 512).found).toBe(true);
  });

  it("keeps looking when only some of the required entries have been seen", () => {
    // A REAL cluster with no baseline marker — the shape a hand-placed PGDATA tar, or a snapshot
    // exported before the platform baseline ran, would have. It must not pass.
    const bare = concat(
      tarEntry("data/", "", "5"),
      tarEntry(LEGACY_PGDATA_CLUSTER_ENTRY, "17\n"),
      TAR_END,
    );
    const state = scan(bare, 512);
    expect(state.found).toBe(false);
    expect(state.ended).toBe(true);
    expect([...state.missing]).toEqual([LEGACY_PGDATA_BASELINE_MARKER_ENTRY]);
    // ...and the same bytes DO pass once the marker is there, so nothing else about them is wrong.
    const stamped = concat(bare.subarray(0, bare.length - TAR_END.length), MARKER_ENTRY, TAR_END);
    expect(scan(stamped, 512).found).toBe(true);
  });

  it("reports a valid but cluster-less archive as not found", () => {
    expect(scan(TAR_END, 512)).toMatchObject({ found: false, ended: true, malformed: false });
    expect([...scan(TAR_END, 512).missing]).toEqual([...LEGACY_PGDATA_REQUIRED_ENTRIES]);
    const otherEntries = concat(tarEntry("data/base/1/2345", "rows"), TAR_END);
    expect(scan(otherEntries, 512)).toMatchObject({ found: false, ended: true });
  });

  it("never mistakes file content for a header", () => {
    // A member whose CONTENT is itself a valid `data/PG_VERSION` header — only the real member
    // list counts, so this archive must come back cluster-less.
    const decoy = new TextDecoder().decode(tarEntry(LEGACY_PGDATA_CLUSTER_ENTRY, "17\n"));
    expect(scan(concat(tarEntry("data/decoy", decoy), TAR_END), 512).found).toBe(false);
  });

  it("settles as malformed on bytes that are not a tar", () => {
    expect(scan(encoder.encode("x".repeat(4096)), 512).malformed).toBe(true);
    // A header whose checksum does not add up (a flipped byte in an otherwise real archive).
    const corrupted = concat(tarEntry("data/PG_VERSION", "17\n"), MARKER_ENTRY, TAR_END);
    corrupted[5] = 0x41;
    expect(scan(corrupted, 512).malformed).toBe(true);
  });

  it("treats a truncated trailing block as the end of what it can read", () => {
    // No end marker and a half header: nothing found, but nothing claimed either.
    const truncated = concat(tarEntry("data/base/1/2345", "rows")).subarray(0, BLOCK + 100);
    expect(scan(truncated, 512)).toMatchObject({ found: false, ended: false, malformed: false });
  });
});

describe("legacyPgDataBaselineMarkerTar", () => {
  it("stamps the very entry the pre-restore scan requires, carrying its key", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // The stamp and the check are two halves of one contract, and only a round trip proves
        // they agree — on the entry name AND on the content encoding: `docker cp - <id>:<PGDATA>`
        // unpacks this archive's members RELATIVE to PGDATA, so its bare `SUPABASE_BASELINE`
        // member is what a later export tars up as `data/SUPABASE_BASELINE`.
        const bytes = yield* legacyPgDataBaselineMarkerTar(KEY);
        const stamped = scan(
          bytes,
          512,
          [LEGACY_PGDATA_BASELINE_MARKER_NAME],
          LEGACY_PGDATA_BASELINE_MARKER_NAME,
        );
        expect(stamped.found).toBe(true);
        // What the warm path compares against: the key this snapshot is published under, in the
        // one canonical form both halves go through.
        expect(stamped.capturedText).toBe(legacyPgDataBaselineMarkerContent(KEY));
        // ...so a snapshot stamped with ANOTHER key does not read as this one's.
        const otherKey = yield* legacyPgDataBaselineMarkerTar("ffffffff00000000");
        expect(
          scan(
            otherKey,
            512,
            [LEGACY_PGDATA_BASELINE_MARKER_NAME],
            LEGACY_PGDATA_BASELINE_MARKER_NAME,
          ).capturedText,
        ).not.toBe(legacyPgDataBaselineMarkerContent(KEY));
        // Nothing else rides along — one member, so the stamp costs a couple of blocks.
        expect(scan(bytes, 512, [LEGACY_PGDATA_BASELINE_MARKER_ENTRY]).found).toBe(false);
      }),
    ));
});
