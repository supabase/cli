import { describe, expect, test } from "vitest";
import { createTar, TarFieldTooLargeError, TarPathTooLongError } from "./tar.ts";

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
  test("writes a readable ustar header for a file", () => {
    const archive = createTar([
      { path: "index.js", contents: encoder.encode("hello"), mode: 0o644, mtime: 1_700_000_000 },
    ]);

    expect(value(archive, 0, 0, 100)).toBe("index.js");
    expect(value(archive, 0, 100, 8)).toBe("0000644");
    expect(value(archive, 0, 124, 12)).toBe("00000000005");
    expect(value(archive, 0, 136, 12)).toBe("14524770400");
    expect(field(archive, 0, 156, 1)).toBe("0");
    expect(value(archive, 0, 257, 6)).toBe("ustar");
  });

  test("computes a checksum the standard algorithm reproduces", () => {
    const archive = createTar([{ path: "a.txt", contents: encoder.encode("a") }]);
    const header = archive.subarray(0, 512);

    const recorded = Number.parseInt(value(archive, 0, 148, 8), 8);
    let computed = 0;
    for (let index = 0; index < 512; index++) {
      // The checksum field itself counts as spaces.
      computed += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }

    expect(recorded).toBe(computed);
  });

  test("pads content to a 512-byte boundary and ends with two zero blocks", () => {
    const archive = createTar([{ path: "a.txt", contents: encoder.encode("hello") }]);

    // header + one padded content block + two trailing zero blocks
    expect(archive.length).toBe(512 * 4);
    expect(decoder.decode(archive.subarray(512, 517))).toBe("hello");
    expect(archive.subarray(512 * 2).every((byte) => byte === 0)).toBe(true);
  });

  test("emits directory entries with no content and the directory typeflag", () => {
    const archive = createTar([
      { path: "nested/", contents: new Uint8Array(0), mode: 0o755 },
      { path: "nested/a.txt", contents: encoder.encode("a") },
    ]);

    expect(field(archive, 0, 156, 1)).toBe("5");
    expect(value(archive, 0, 124, 12)).toBe("00000000000");
    // The directory has no content block, so the next header follows immediately.
    expect(value(archive, 1, 0, 100)).toBe("nested/a.txt");
  });

  test("stores a symlink as a link entry with no content blocks", () => {
    const archive = createTar([
      { path: "link.txt", contents: new Uint8Array(0), linkTarget: "target.txt", mode: 0o777 },
    ]);

    expect(field(archive, 0, 156, 1)).toBe("2");
    expect(value(archive, 0, 157, 100)).toBe("target.txt");
    expect(value(archive, 0, 124, 12)).toBe("00000000000");
    // Header plus the two trailing zero blocks — no content block in between.
    expect(archive.length).toBe(512 * 3);
  });

  test("a symlink entry wins over the trailing-slash directory rule", () => {
    const archive = createTar([{ path: "dir", contents: new Uint8Array(0), linkTarget: ".." }]);

    expect(field(archive, 0, 156, 1)).toBe("2");
  });

  test("refuses a link target too long for the header field", () => {
    expect(() =>
      createTar([
        { path: "link", contents: new Uint8Array(0), linkTarget: `${"t".repeat(120)}.txt` },
      ]),
    ).toThrow(TarPathTooLongError);
  });

  test("splits a long path across the prefix and name fields", () => {
    const deep = `${"d".repeat(120)}/${"f".repeat(60)}.txt`;
    const archive = createTar([{ path: deep, contents: new Uint8Array(0) }]);

    expect(value(archive, 0, 345, 155)).toBe("d".repeat(120));
    expect(value(archive, 0, 0, 100)).toBe(`${"f".repeat(60)}.txt`);
  });

  test("refuses a value too large for an octal header field rather than truncating it", () => {
    // One past the 11-digit octal ceiling. Encoding it would spill a digit into
    // the next field and read back as a plausible but wrong number.
    expect(() =>
      createTar([{ path: "a.txt", contents: new Uint8Array(1), mtime: 8 ** 11 }]),
    ).toThrow(TarFieldTooLargeError);

    expect(() =>
      createTar([{ path: "a.txt", contents: new Uint8Array(1), mtime: 8 ** 11 - 1 }]),
    ).not.toThrow();
  });

  test("refuses a path component too long to represent", () => {
    expect(() =>
      createTar([{ path: `${"f".repeat(120)}.txt`, contents: new Uint8Array(0) }]),
    ).toThrow(TarPathTooLongError);
  });
});
