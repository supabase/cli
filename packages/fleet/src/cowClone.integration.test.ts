import { mkdtemp, mkdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloneDir } from "./cowClone.ts";

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
});
