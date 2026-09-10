import { BunServices } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { gunzipSync } from "node:zlib";
import { Cause, DateTime, Effect, Exit, FileSystem, Option, Path } from "effect";
import { describe, expect, test } from "vitest";
import { ComputeSourceEscapingLinkError } from "./compute.errors.ts";
import { formatBytes, packageComputeDirectory } from "./compute-package.ts";
import { TarFieldOutOfRangeError, TarPathTooLongError } from "./tar.ts";

/**
 * Whether the current user can still read `path` after it was chmod-ed shut. Root ignores
 * permission bits, and CI sometimes runs as root, so the permission-denied tests below assert
 * the opposite outcome instead of skipping — either way the behavior under test is pinned.
 */
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

const withTemp = <A, E, R>(
  prefix: string,
  run: (dir: string, fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix });
      return yield* run(dir, fs, path);
    }),
  ).pipe(Effect.provide(BunServices.layer));

describe("packageComputeDirectory", () => {
  const pack = (root: string) =>
    packageComputeDirectory(root).pipe(Effect.provide(BunServices.layer));

  it.live("packages files and nested directories in a stable order", () =>
    withTemp("supabase-compute-package-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(dir, "nested"));
        yield* fs.writeFileString(path.join(dir, "b.txt"), "b");
        yield* fs.writeFileString(path.join(dir, "a.txt"), "a");
        yield* fs.writeFileString(path.join(dir, "nested", "c.txt"), "c");

        const result = yield* pack(dir);

        expect(readEntries(result.archive).map((entry) => entry.path)).toEqual([
          "a.txt",
          "b.txt",
          "nested/",
          "nested/c.txt",
        ]);
        expect(result.fileCount).toBe(3);
      }),
    ),
  );

  // Anything pnpm installs is symlink-dense, so following links would inline
  // every dependency's real contents — and a link pointing at an ancestor would
  // be walked into until the OS refused.
  it.live("stores symlinks as links rather than following them", () =>
    withTemp("supabase-compute-package-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(dir, "target.txt"), "hello");
        yield* fs.symlink("target.txt", path.join(dir, "link.txt"));

        const entries = readEntries((yield* pack(dir)).archive);
        const link = entries.find((entry) => entry.path === "link.txt");

        expect(link?.type).toBe("2");
        expect(link?.link).toBe("target.txt");
      }),
    ),
  );

  // Broken, but pointing at a name inside the tree: whether the target exists is
  // the server's problem once the archive is extracted, and dropping the link
  // would change the tree the build sees.
  it.live("keeps a broken symlink instead of dropping it", () =>
    withTemp("supabase-compute-package-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.symlink("nowhere-at-all.txt", path.join(dir, "broken.txt"));

        const entries = readEntries((yield* pack(dir)).archive);

        expect(entries.find((entry) => entry.path === "broken.txt")?.type).toBe("2");
      }),
    ),
  );

  // The archive is the whole of what the server gets, so a link out of it
  // arrives dangling however valid it is here. Refused while the user is still
  // at the terminal, rather than surfacing as a remote build failure.
  it.live.each([
    { label: "a relative escape", target: "../../outside.txt" },
    { label: "an absolute escape", target: "/nowhere-at-all" },
    {
      label: "a hoisted dependency",
      target: "../../node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad",
    },
  ])("refuses $label out of the build context", ({ target }) =>
    withTemp("supabase-compute-package-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(dir, "nested"));
        yield* fs.symlink(target, path.join(dir, "nested", "dep"));

        const exit = yield* packageComputeDirectory(dir).pipe(
          Effect.provide(BunServices.layer),
          Effect.exit,
        );
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
        const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
        expect(Option.isSome(failure) ? failure.value : undefined).toBeInstanceOf(
          ComputeSourceEscapingLinkError,
        );
      }),
    ),
  );

  // An absolute target that lands back inside the tree is a path on this
  // machine; stored verbatim it would resolve to nothing on the other end.
  it.live("rewrites an absolute in-tree link target as a relative one", () =>
    withTemp("supabase-compute-package-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(dir, "target.txt"), "t");
        yield* fs.makeDirectory(path.join(dir, "nested"));
        yield* fs.symlink(path.join(dir, "target.txt"), path.join(dir, "nested", "link.txt"));

        const entries = readEntries((yield* pack(dir)).archive);

        expect(entries.find((entry) => entry.path === "nested/link.txt")?.link).toBe(
          "../target.txt",
        );
      }),
    ),
  );

  it.live("does not recurse through a directory symlink that points at an ancestor", () =>
    withTemp("supabase-compute-package-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(dir, "sub"));
        yield* fs.writeFileString(path.join(dir, "keep.txt"), "k");
        yield* fs.symlink("..", path.join(dir, "sub", "up"));

        const entries = readEntries((yield* pack(dir)).archive);

        expect(entries.map((entry) => entry.path).sort()).toEqual(["keep.txt", "sub/", "sub/up"]);
        expect(entries.find((entry) => entry.path === "sub/up")?.type).toBe("2");
      }),
    ),
  );

  // A pre-1970 mtime is negative, and a negative number is not representable in
  // a USTAR octal field: `(-1).toString(8)` renders to exactly the field width,
  // so it would sail past the width check and ship a header GNU tar rejects
  // after the upload. A botched `touch` is not worth failing a deploy over, so
  // the timestamp collapses to the epoch instead.
  it.live("packages a file with a pre-epoch mtime, timestamped at the epoch", () =>
    withTemp("supabase-compute-package-", (dir, fs, path) =>
      Effect.gen(function* () {
        const file = path.join(dir, "a.txt");
        yield* fs.writeFileString(file, "a");
        yield* fs.utimes(file, -86_400, -86_400);

        const result = yield* pack(dir);

        const entry = readEntries(result.archive).find((candidate) => candidate.path === "a.txt");
        // Some filesystems refuse a pre-epoch timestamp and clamp it on the way in,
        // in which case there is nothing to collapse — either way the field has to
        // be a plain octal number the archive can carry.
        const stored = Option.match((yield* fs.stat(file)).mtime, {
          onNone: () => 0,
          onSome: (mtime) => DateTime.toEpochMillis(DateTime.makeUnsafe(mtime)),
        });
        expect(entry?.mtime).toBe(stored < 0 ? "00000000000" : expectedOctalMtime(stored));
      }),
    ),
  );

  it.live("packages an empty directory to an archive with no entries", () =>
    withTemp("supabase-compute-package-", (dir, _fs, _path) =>
      Effect.gen(function* () {
        const result = yield* pack(dir);

        expect(readEntries(result.archive)).toEqual([]);
        expect(result.fileCount).toBe(0);
      }),
    ),
  );

  // Archiving an unreadable file as zero bytes would report success for a deploy
  // carrying an empty file. Failing is the only honest answer: the archive is the
  // application.
  it.live("fails rather than archiving a file it cannot read as empty", () =>
    withTemp("supabase-compute-package-", (dir, fs, path) =>
      Effect.gen(function* () {
        const unreadable = path.join(dir, "secret.txt");
        yield* fs.writeFileString(unreadable, "important");
        // Restore access before the temp-directory scope removes the fixture.
        yield* Effect.acquireRelease(fs.chmod(unreadable, 0o000), () =>
          fs.chmod(unreadable, 0o600).pipe(Effect.orDie),
        );

        const exit = yield* packageComputeDirectory(dir).pipe(
          Effect.provide(BunServices.layer),
          Effect.exit,
        );

        // Running as root defeats the permission, so only assert when it took hold.
        if (
          yield* fs.access(unreadable, { readable: true }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        ) {
          expect(Exit.isSuccess(exit)).toBe(true);
        } else {
          expect(Exit.isFailure(exit)).toBe(true);
        }
      }),
    ),
  );

  it.live("fails rather than silently dropping a directory it cannot read", () =>
    withTemp("supabase-compute-package-", (dir, fs, path) =>
      Effect.gen(function* () {
        const locked = path.join(dir, "locked");
        yield* fs.makeDirectory(locked);
        yield* fs.writeFileString(path.join(locked, "inside.txt"), "content");
        // Restore access before the temp-directory scope removes the fixture.
        yield* Effect.acquireRelease(fs.chmod(locked, 0o000), () =>
          fs.chmod(locked, 0o700).pipe(Effect.orDie),
        );

        const exit = yield* packageComputeDirectory(dir).pipe(
          Effect.provide(BunServices.layer),
          Effect.exit,
        );

        if (
          yield* fs.readDirectory(locked).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        ) {
          expect(Exit.isSuccess(exit)).toBe(true);
        } else {
          expect(Exit.isFailure(exit)).toBe(true);
        }
      }),
    ),
  );
});

// Tar validation stays in the Effect failure channel, so structured output can
// render an actionable error instead of treating it as an uncaught defect.
describe("packageComputeDirectory tar limits", () => {
  it.live("reports an unrepresentable path as a failure rather than a defect", () =>
    withTemp("supabase-compute-tar-", (dir, fs, path) =>
      Effect.gen(function* () {
        // One component over 100 bytes, with no directory boundary to split on.
        yield* fs.writeFileString(path.join(dir, "a".repeat(120)), "contents");

        const exit = yield* packageComputeDirectory(dir).pipe(
          Effect.provide(BunServices.layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        // A failure, not a defect: the difference is whether the JSON error handler
        // ever sees it. `Exit.isFailure` alone does not say which, since a defect
        // exits that way too — the cause is what tells them apart.
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
        const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
        expect(Option.isSome(failure) ? failure.value : undefined).toBeInstanceOf(
          TarPathTooLongError,
        );
      }),
    ),
  );

  // The other half of the same rule. `TarFieldOutOfRangeError` declares itself
  // user-actionable too, and that declaration can only take effect if the error
  // reaches the failure channel rather than being rethrown as a defect. An 8 GiB
  // file trips it through the size field; a far-future mtime is the same check
  // for the price of a `utimes` call.
  it.live("reports an out-of-range header field as a failure rather than a defect", () =>
    withTemp("supabase-compute-tar-", (dir, fs, path) =>
      Effect.gen(function* () {
        const file = path.join(dir, "a.txt");
        yield* fs.writeFileString(file, "contents");
        // One past the 11-digit octal ceiling, a little past the year 2242.
        yield* fs.utimes(file, 8 ** 11, 8 ** 11);

        const exit = yield* packageComputeDirectory(dir).pipe(
          Effect.provide(BunServices.layer),
          Effect.exit,
        );

        // Filesystems that cannot hold a timestamp that far out clamp it on the way
        // in, which leaves nothing out of range to report.
        const stored = Option.match((yield* fs.stat(file)).mtime, {
          onNone: () => 0,
          onSome: (mtime) => DateTime.toEpochMillis(DateTime.makeUnsafe(mtime)),
        });
        if (Math.floor(stored / 1000) > 8 ** 11 - 1) {
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
          expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
          const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
          expect(Option.isSome(failure) ? failure.value : undefined).toBeInstanceOf(
            TarFieldOutOfRangeError,
          );
        } else {
          expect(Exit.isSuccess(exit)).toBe(true);
        }
      }),
    ),
  );
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
