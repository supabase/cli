import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { gunzipSync } from "node:zlib";
import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatBytes, packageWorkerDirectory } from "./worker-package.ts";

/**
 * Whether the current user can still read `path` after it was chmod-ed shut.
 *
 * Root ignores the permission bits, and CI sometimes runs as root, so the
 * permission-denied tests below assert the opposite outcome instead of skipping
 * — either way the behaviour under test is pinned.
 */
function readableAsCurrentUser(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function listableAsCurrentUser(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

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

  // A file that cannot be read used to be archived as zero bytes, so `push`
  // reported success for a deploy that shipped an empty file. Failing is the
  // only honest answer: the archive is the application.
  test("fails rather than archiving a file it cannot read as empty", async () => {
    const unreadable = join(dir, "secret.txt");
    writeFileSync(unreadable, "important");
    chmodSync(unreadable, 0o000);

    const exit = await Effect.runPromise(
      packageWorkerDirectory(dir).pipe(Effect.provide(BunServices.layer), Effect.exit),
    );

    // Running as root defeats the permission, so only assert when it took hold.
    if (readableAsCurrentUser(unreadable)) {
      expect(Exit.isSuccess(exit)).toBe(true);
    } else {
      expect(Exit.isFailure(exit)).toBe(true);
    }
    chmodSync(unreadable, 0o600);
  });

  test("fails rather than silently dropping a directory it cannot read", async () => {
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "inside.txt"), "content");
    chmodSync(locked, 0o000);

    const exit = await Effect.runPromise(
      packageWorkerDirectory(dir).pipe(Effect.provide(BunServices.layer), Effect.exit),
    );

    if (listableAsCurrentUser(locked)) {
      expect(Exit.isSuccess(exit)).toBe(true);
    } else {
      expect(Exit.isFailure(exit)).toBe(true);
    }
    chmodSync(locked, 0o700);
  });

  // The digest is what decides whether a push has anything to deploy, so what
  // it does and does not notice is behaviour, not an implementation detail.
  test("digests the tree's contents, and not the mtimes the archive carries", async () => {
    writeFileSync(join(dir, "index.js"), "export default {};\n");
    const first = await pack(dir);

    // A fresh clone or checkout rewrites every mtime without touching a byte of
    // the code; that must not read as a new deployment.
    utimesSync(join(dir, "index.js"), new Date(1000), new Date(1000));
    const restamped = await pack(dir);

    expect(restamped.contentDigest).toBe(first.contentDigest);
    expect(restamped.archive).not.toEqual(first.archive);

    writeFileSync(join(dir, "index.js"), "export default { changed: true };\n");
    expect((await pack(dir)).contentDigest).not.toBe(first.contentDigest);
  });

  test("digests a file's executable bit", async () => {
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
    const plain = await pack(dir);

    chmodSync(join(dir, "run.sh"), 0o755);
    expect((await pack(dir)).contentDigest).not.toBe(plain.contentDigest);
  });

  test("digests a symlink's target, not just the name pointing at it", async () => {
    const other = mkdtempSync(join(tmpdir(), "supabase-worker-package-"));
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
    writeFileSync(join(other, "run.sh"), "#!/bin/sh\n");
    symlinkSync("run.sh", join(dir, "start"));
    symlinkSync("elsewhere.sh", join(other, "start"));

    expect((await pack(dir)).contentDigest).not.toBe((await pack(other)).contentDigest);
    rmSync(other, { recursive: true, force: true });
  });
});

// `createTar` throws for a name USTAR cannot represent. Called directly inside
// the generator that became a defect, which `withJsonErrorHandling` does not
// catch — so `--output-format json` would have died with no structured error.
describe("packageWorkerDirectory tar limits", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supabase-worker-tar-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports an unrepresentable path as a failure rather than a defect", async () => {
    // One component over 100 bytes, with no directory boundary to split on.
    writeFileSync(join(dir, "a".repeat(120)), "contents");

    const exit = await Effect.runPromise(
      packageWorkerDirectory(dir).pipe(Effect.provide(BunServices.layer), Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    // A failure, not a defect: the difference is whether the JSON error handler
    // ever sees it.
    expect(JSON.stringify(exit)).toContain("TarPathTooLong");
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
