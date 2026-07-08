import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloneDir } from "./cowClone.ts";

/** Forces the CoW `cp` step to fail deterministically, so tests can exercise the fallback path. */
const FORCE_FALLBACK = { cowCommand: "false" };

describe("cloneDir", () => {
  it("clones a tree with content and modes; clones diverge", async () => {
    const root = await mkdtemp(join(tmpdir(), "cow-test-"));
    const src = join(root, "src");
    await mkdir(join(src, "sub"), { recursive: true });
    await writeFile(join(src, "sub", "a.txt"), "hello");
    await chmod(src, 0o700);

    const dest = join(root, "dest");
    await cloneDir(src, dest);

    expect(await readFile(join(dest, "sub", "a.txt"), "utf8")).toBe("hello");
    expect((await stat(dest)).mode & 0o777).toBe(0o700);

    await writeFile(join(dest, "sub", "a.txt"), "changed");
    expect(await readFile(join(src, "sub", "a.txt"), "utf8")).toBe("hello");
  });

  it("refuses to clone onto an existing destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "cow-test-"));
    const src = join(root, "src");
    await mkdir(src);
    const dest = join(root, "dest");
    await mkdir(dest);
    await expect(cloneDir(src, dest)).rejects.toThrow(/exists/);
  });

  it("creates the destination parent before attempting the CoW clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "cow-test-"));
    const src = join(root, "src");
    await mkdir(src);
    await writeFile(join(src, "file.txt"), "hello");

    const dest = join(root, "missing-parent", "dest");
    await cloneDir(src, dest);

    expect(await readFile(join(dest, "file.txt"), "utf8")).toBe("hello");
  });

  it("does not silently mix stale CoW leftovers with fallback output when the CoW command fails after partially writing dest", async () => {
    const root = await mkdtemp(join(tmpdir(), "cow-test-"));
    const src = join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "fresh.txt"), "fresh-from-src");

    const dest = join(root, "dest");

    // Use a "CoW command" that partially writes dest (mkdir + one file) and then fails,
    // to model a real clonefile/reflink command that dies partway through. cloneDir
    // invokes it as `<cowCommand> <flags...> <src> <dest>`, so `dest` is always the
    // last argument regardless of platform-specific flags.
    const partialWriteThenFail = join(root, "partial-write-then-fail.sh");
    await writeFile(
      partialWriteThenFail,
      `#!/bin/sh\nlast=""\nfor arg in "$@"; do last="$arg"; done\nmkdir -p "$last"\necho "leftover" > "$last/leftover.txt"\nexit 1\n`,
      { mode: 0o755 },
    );

    await cloneDir(src, dest, { cowCommand: partialWriteThenFail });

    // The fallback must have run to completion (fresh.txt present)...
    expect(await readFile(join(dest, "fresh.txt"), "utf8")).toBe("fresh-from-src");
    // ...and the stale leftover from the failed CoW attempt must be gone, not silently
    // preserved alongside the fallback's output.
    await expect(stat(join(dest, "leftover.txt"))).rejects.toThrow();
  });

  it("preserves relative symlink targets through the fallback copy (verbatimSymlinks)", async () => {
    const root = await mkdtemp(join(tmpdir(), "cow-test-"));
    const src = join(root, "src");
    await mkdir(join(src, "sub"), { recursive: true });
    await writeFile(join(src, "sub", "target.txt"), "hi");
    await symlink("target.txt", join(src, "sub", "link.txt"));

    const dest = join(root, "dest");
    await cloneDir(src, dest, FORCE_FALLBACK);

    expect(await readlink(join(dest, "sub", "link.txt"))).toBe("target.txt");
    expect(await readFile(join(dest, "sub", "link.txt"), "utf8")).toBe("hi");
  });
});
