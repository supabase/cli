import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { createTar, TarFieldOutOfRangeError, TarPathTooLongError } from "./tar.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function field(archive: Uint8Array, block: number, offset: number, length: number): string {
  return decoder.decode(archive.subarray(block * 512 + offset, block * 512 + offset + length));
}

/** Trim a NUL-padded USTAR field down to its value. */
function value(archive: Uint8Array, block: number, offset: number, length: number): string {
  return (field(archive, block, offset, length).split("\u0000")[0] ?? "").trim();
}

describe("createTar", () => {
  it.live("writes a readable ustar header for a file", () =>
    Effect.gen(function* () {
      const archive = yield* createTar([
        { path: "index.js", contents: encoder.encode("hello"), mode: 0o644, mtime: 1_700_000_000 },
      ]);

      expect(value(archive, 0, 0, 100)).toBe("index.js");
      expect(value(archive, 0, 100, 8)).toBe("0000644");
      expect(value(archive, 0, 124, 12)).toBe("00000000005");
      expect(value(archive, 0, 136, 12)).toBe("14524770400");
      expect(field(archive, 0, 156, 1)).toBe("0");
      expect(value(archive, 0, 257, 6)).toBe("ustar");
    }),
  );

  it.live("computes a checksum the standard algorithm reproduces", () =>
    Effect.gen(function* () {
      const archive = yield* createTar([{ path: "a.txt", contents: encoder.encode("a") }]);
      const header = archive.subarray(0, 512);

      const recorded = Number.parseInt(value(archive, 0, 148, 8), 8);
      let computed = 0;
      for (let index = 0; index < 512; index++) {
        computed += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
      }

      expect(recorded).toBe(computed);
    }),
  );

  it.live("pads content to a 512-byte boundary and ends with two zero blocks", () =>
    Effect.gen(function* () {
      const archive = yield* createTar([{ path: "a.txt", contents: encoder.encode("hello") }]);

      expect(archive.length).toBe(512 * 4);
      expect(decoder.decode(archive.subarray(512, 517))).toBe("hello");
      expect(archive.subarray(512 * 2).every((byte) => byte === 0)).toBe(true);
    }),
  );

  it.live("emits directory entries with no content and the directory typeflag", () =>
    Effect.gen(function* () {
      const archive = yield* createTar([
        { path: "nested/", contents: new Uint8Array(0), mode: 0o755 },
        { path: "nested/a.txt", contents: encoder.encode("a") },
      ]);

      expect(field(archive, 0, 156, 1)).toBe("5");
      expect(value(archive, 0, 124, 12)).toBe("00000000000");
      expect(value(archive, 1, 0, 100)).toBe("nested/a.txt");
    }),
  );

  it.live("stores a symlink as a link entry with no content blocks", () =>
    Effect.gen(function* () {
      const archive = yield* createTar([
        { path: "link.txt", contents: new Uint8Array(0), linkTarget: "target.txt", mode: 0o777 },
      ]);

      expect(field(archive, 0, 156, 1)).toBe("2");
      expect(value(archive, 0, 157, 100)).toBe("target.txt");
      expect(value(archive, 0, 124, 12)).toBe("00000000000");
      expect(archive.length).toBe(512 * 3);
    }),
  );

  it.live("a symlink entry wins over the trailing-slash directory rule", () =>
    Effect.gen(function* () {
      const archive = yield* createTar([
        { path: "dir", contents: new Uint8Array(0), linkTarget: ".." },
      ]);
      expect(field(archive, 0, 156, 1)).toBe("2");
    }),
  );

  it.live("refuses a link target too long for the header field", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createTar([
          { path: "link", contents: new Uint8Array(0), linkTarget: `${"t".repeat(120)}.txt` },
        ]),
      );
      expect(error).toBeInstanceOf(TarPathTooLongError);
    }),
  );

  it.live("splits a long path across the prefix and name fields", () =>
    Effect.gen(function* () {
      const deep = `${"d".repeat(120)}/${"f".repeat(60)}.txt`;
      const archive = yield* createTar([{ path: deep, contents: new Uint8Array(0) }]);

      expect(value(archive, 0, 345, 155)).toBe("d".repeat(120));
      expect(value(archive, 0, 0, 100)).toBe(`${"f".repeat(60)}.txt`);
    }),
  );

  it.live("refuses a value too large for an octal header field rather than truncating it", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createTar([{ path: "a.txt", contents: new Uint8Array(1), mtime: 8 ** 11 }]),
      );
      expect(error).toBeInstanceOf(TarFieldOutOfRangeError);

      yield* createTar([{ path: "a.txt", contents: new Uint8Array(1), mtime: 8 ** 11 - 1 }]);
    }),
  );

  it.live("can evaluate one archive Effect more than once", () =>
    Effect.gen(function* () {
      const archive = createTar([{ path: "a.txt", contents: encoder.encode("a") }]);
      const first = yield* archive;
      const second = yield* archive;

      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    }),
  );

  it.live.each([
    { label: "a pre-epoch mtime", mtime: -1 },
    { label: "an mtime from an invalid date", mtime: Number.NaN },
    { label: "an infinite mtime", mtime: Number.POSITIVE_INFINITY },
  ])("refuses $label rather than writing a field no tar can parse", ({ mtime }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createTar([{ path: "a.txt", contents: new Uint8Array(1), mtime }]),
      );
      expect(error).toBeInstanceOf(TarFieldOutOfRangeError);
    }),
  );

  it.live("refuses a negative mode rather than writing a field no tar can parse", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createTar([{ path: "a.txt", contents: new Uint8Array(1), mode: -1 }]),
      );
      expect(error).toBeInstanceOf(TarFieldOutOfRangeError);
    }),
  );

  it.live("refuses a path component too long to represent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createTar([{ path: `${"f".repeat(120)}.txt`, contents: new Uint8Array(0) }]),
      );
      expect(error).toBeInstanceOf(TarPathTooLongError);
    }),
  );
});
