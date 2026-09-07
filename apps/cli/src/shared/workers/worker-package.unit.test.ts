import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { gunzipSync } from "node:zlib";
import { Cause, Effect, Exit } from "effect";
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

/** Entry paths, USTAR typeflags and mtimes, read back out of the archive. */
function readEntries(
  archive: Uint8Array,
): Array<{ path: string; type: string; link: string; mtime: string }> {
  const raw = new Uint8Array(gunzipSync(archive));
  const decoder = new TextDecoder();
  const trim = (value: string) => value.split("\u0000")[0] ?? "";
  const entries: Array<{ path: string; type: string; link: string; mtime: string }> = [];

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
      mtime: trim(decoder.decode(raw.subarray(offset + 136, offset + 148))),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** The 11-digit octal a tar header carries for `mtimeMs`. */
function expectedOctalMtime(mtimeMs: number): string {
  return Math.floor(mtimeMs / 1000)
    .toString(8)
    .padStart(11, "0");
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

  // Broken, but pointing at a name inside the tree: whether the target exists is
  // the server's problem once the archive is extracted, and dropping the link
  // would change the tree the build sees.
  test("keeps a broken symlink instead of dropping it", async () => {
    symlinkSync("nowhere-at-all.txt", join(dir, "broken.txt"));

    const entries = readEntries((await pack(dir)).archive);

    expect(entries.find((entry) => entry.path === "broken.txt")?.type).toBe("2");
  });

  // The archive is the whole of what the server gets, so a link out of it
  // arrives dangling however valid it is here. Refused while the user is still
  // at the terminal, rather than surfacing as a remote build failure.
  test.each([
    ["a relative escape", "../../outside.txt"],
    ["an absolute escape", "/nowhere-at-all"],
    ["a hoisted dependency", "../../node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad"],
  ])("refuses %s out of the build context", async (_label, target) => {
    mkdirSync(join(dir, "nested"));
    symlinkSync(target, join(dir, "nested", "dep"));

    const exit = await Effect.runPromise(
      packageWorkerDirectory(dir).pipe(Effect.provide(BunServices.layer), Effect.exit),
    );

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
    expect(JSON.stringify(exit)).toContain("WorkerSourceEscapingLinkError");
  });

  // An absolute target that lands back inside the tree is a path on this
  // machine; stored verbatim it would resolve to nothing on the other end.
  test("rewrites an absolute in-tree link target as a relative one", async () => {
    writeFileSync(join(dir, "target.txt"), "t");
    mkdirSync(join(dir, "nested"));
    symlinkSync(join(dir, "target.txt"), join(dir, "nested", "link.txt"));

    const entries = readEntries((await pack(dir)).archive);

    expect(entries.find((entry) => entry.path === "nested/link.txt")?.link).toBe("../target.txt");
  });

  test("does not recurse through a directory symlink that points at an ancestor", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "keep.txt"), "k");
    symlinkSync("..", join(dir, "sub", "up"));

    const entries = readEntries((await pack(dir)).archive);

    expect(entries.map((entry) => entry.path).sort()).toEqual(["keep.txt", "sub/", "sub/up"]);
    expect(entries.find((entry) => entry.path === "sub/up")?.type).toBe("2");
  });

  // A pre-1970 mtime is negative, and a negative number is not representable in
  // a USTAR octal field: `(-1).toString(8)` renders to exactly the field width,
  // so it would sail past the width check and ship a header GNU tar rejects
  // after the upload. A botched `touch` is not worth failing a deploy over, so
  // the timestamp collapses to the epoch instead.
  test("packages a file with a pre-epoch mtime, timestamped at the epoch", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "a");
    utimesSync(file, new Date(-86_400_000), new Date(-86_400_000));

    const result = await pack(dir);

    const entry = readEntries(result.archive).find((candidate) => candidate.path === "a.txt");
    // Some filesystems refuse a pre-epoch timestamp and clamp it on the way in,
    // in which case there is nothing to collapse — either way the field has to
    // be a plain octal number the archive can carry.
    const stored = statSync(file).mtimeMs;
    expect(entry?.mtime).toBe(stored < 0 ? "00000000000" : expectedOctalMtime(stored));
  });

  test("packages an empty directory to an archive with no entries", async () => {
    const result = await pack(dir);

    expect(readEntries(result.archive)).toEqual([]);
    expect(result.fileCount).toBe(0);
  });

  // Archiving an unreadable file as zero bytes would report success for a deploy
  // carrying an empty file. Failing is the only honest answer: the archive is the
  // application.
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
    // ever sees it. `Exit.isFailure` alone does not say which, since a defect
    // exits that way too — the cause is what tells them apart.
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
    expect(JSON.stringify(exit)).toContain("TarPathTooLong");
  });

  // The other half of the same rule. `TarFieldOutOfRangeError` declares itself
  // user-actionable too, and that declaration can only take effect if the error
  // reaches the failure channel rather than being rethrown as a defect. An 8 GiB
  // file trips it through the size field; a far-future mtime is the same check
  // for the price of a `utimes` call.
  test("reports an out-of-range header field as a failure rather than a defect", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "contents");
    // One past the 11-digit octal ceiling, a little past the year 2242.
    utimesSync(file, 8 ** 11, 8 ** 11);

    const exit = await Effect.runPromise(
      packageWorkerDirectory(dir).pipe(Effect.provide(BunServices.layer), Effect.exit),
    );

    // Filesystems that cannot hold a timestamp that far out clamp it on the way
    // in, which leaves nothing out of range to report.
    if (Math.floor(statSync(file).mtimeMs / 1000) > 8 ** 11 - 1) {
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
      expect(JSON.stringify(exit)).toContain("TarFieldOutOfRange");
    } else {
      expect(Exit.isSuccess(exit)).toBe(true);
    }
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
