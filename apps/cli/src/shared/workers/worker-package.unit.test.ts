import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { gunzipSync } from "node:zlib";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatBytes, packageWorkerDirectory } from "./worker-package.ts";

/** Entry paths and their USTAR typeflags, read back out of the archive. */
function readEntries(archive: Uint8Array): Array<{ path: string; type: string; link: string }> {
  const raw = new Uint8Array(gunzipSync(archive));
  const decoder = new TextDecoder();
  const trim = (value: string) => value.split("\u0000")[0] ?? "";
  const entries: Array<{ path: string; type: string; link: string }> = [];

  for (let offset = 0; offset + 512 <= raw.length;) {
    const name = trim(decoder.decode(raw.subarray(offset, offset + 100)));
    if (name === "") {
      break;
    }
    const size = Number.parseInt(trim(decoder.decode(raw.subarray(offset + 124, offset + 136))), 8);
    entries.push({
      path: name,
      type: decoder.decode(raw.subarray(offset + 156, offset + 157)),
      link: trim(decoder.decode(raw.subarray(offset + 157, offset + 257))),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("packageWorkerDirectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supabase-worker-package-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pack = (root: string) =>
    Effect.runPromise(packageWorkerDirectory(root).pipe(Effect.provide(BunServices.layer)));

  test("packages files and nested directories in a stable order", async () => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "b.txt"), "b");
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "nested", "c.txt"), "c");

    const result = await pack(dir);

    expect(readEntries(result.archive).map((entry) => entry.path)).toEqual([
      "a.txt",
      "b.txt",
      "nested/",
      "nested/c.txt",
    ]);
    expect(result.fileCount).toBe(3);
  });

  // Anything pnpm installs is symlink-dense, so following links would inline
  // every dependency's real contents — and a link pointing at an ancestor would
  // be walked into until the OS refused.
  test("stores symlinks as links rather than following them", async () => {
    writeFileSync(join(dir, "target.txt"), "hello");
    symlinkSync("target.txt", join(dir, "link.txt"));

    const entries = readEntries((await pack(dir)).archive);
    const link = entries.find((entry) => entry.path === "link.txt");

    expect(link?.type).toBe("2");
    expect(link?.link).toBe("target.txt");
  });

  test("keeps a broken symlink instead of dropping it", async () => {
    symlinkSync("/nowhere-at-all", join(dir, "broken.txt"));

    const entries = readEntries((await pack(dir)).archive);

    expect(entries.find((entry) => entry.path === "broken.txt")?.type).toBe("2");
  });

  test("does not recurse through a directory symlink that points at an ancestor", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "keep.txt"), "k");
    symlinkSync("..", join(dir, "sub", "up"));

    const entries = readEntries((await pack(dir)).archive);

    expect(entries.map((entry) => entry.path).sort()).toEqual(["keep.txt", "sub/", "sub/up"]);
    expect(entries.find((entry) => entry.path === "sub/up")?.type).toBe("2");
  });

  test("packages an empty directory to an archive with no entries", async () => {
    const result = await pack(dir);

    expect(readEntries(result.archive)).toEqual([]);
    expect(result.fileCount).toBe(0);
  });
});

describe("formatBytes", () => {
  test("reports each magnitude in the unit a reader expects", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MiB");
  });
});
