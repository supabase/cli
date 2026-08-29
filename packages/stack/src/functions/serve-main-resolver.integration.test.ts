import {
  mkdtemp,
  mkdir,
  readdir,
  lstat,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFunctionConfig, type FunctionFileSystem } from "./serve-main-resolver.ts";

const nodeFileSystem: FunctionFileSystem = {
  lstat: async (path) => {
    const info = await lstat(path);
    return {
      isDirectory: info.isDirectory(),
      isFile: info.isFile(),
      isSymbolicLink: info.isSymbolicLink(),
    };
  },
  realPath: (path) => realpath(path),
  readDirectory: async (path) => readdir(path),
};

describe("Edge Runtime request-time function resolver", () => {
  it("discovers defaults and reflects live create/edit/delete without caching", async () => {
    const root = await mkdtemp(join(tmpdir(), "stack-functions-resolver-"));
    try {
      const hello = join(root, "hello");
      await mkdir(hello, { recursive: true });
      await writeFile(join(hello, "index.ts"), "export default 1");
      await writeFile(join(hello, "deno.json"), "{}");
      const canonicalRoot = await realpath(root);

      const defaults = await resolveFunctionConfig({
        root,
        slug: "hello",
        overrides: {},
        fs: nodeFileSystem,
      });
      expect(defaults).toMatchObject({
        entrypointPath: join(canonicalRoot, "hello", "index.ts"),
        importMapPath: join(canonicalRoot, "hello", "deno.json"),
        verifyJWT: true,
      });

      await writeFile(join(hello, "index.ts"), "export default 2");
      const edited = await resolveFunctionConfig({
        root,
        slug: "hello",
        overrides: {},
        fs: nodeFileSystem,
      });
      expect(edited?.entrypointPath).toBe(defaults?.entrypointPath);

      const created = join(root, "new-function");
      await mkdir(created);
      await writeFile(join(created, "index.ts"), "export default 3");
      expect(
        await resolveFunctionConfig({
          root,
          slug: "new-function",
          overrides: {},
          fs: nodeFileSystem,
        }),
      ).toMatchObject({
        verifyJWT: true,
        entrypointPath: join(canonicalRoot, "new-function", "index.ts"),
      });

      await unlink(join(hello, "index.ts"));
      expect(
        await resolveFunctionConfig({ root, slug: "hello", overrides: {}, fs: nodeFileSystem }),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an absolute root and rejects traversal and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "stack-functions-resolver-paths-"));
    const outside = await mkdtemp(join(tmpdir(), "stack-functions-resolver-outside-"));
    try {
      await mkdir(join(root, "safe"));
      await writeFile(join(root, "safe", "index.ts"), "export default 1");
      await writeFile(join(outside, "index.ts"), "export default 2");
      expect(
        await resolveFunctionConfig({ root: "", slug: "safe", overrides: {}, fs: nodeFileSystem }),
      ).toBeUndefined();
      expect(
        await resolveFunctionConfig({
          root,
          slug: "safe",
          overrides: { safe: { entrypoint: "../outside.ts" } },
          fs: nodeFileSystem,
        }),
      ).toBeUndefined();

      await symlink(outside, join(root, "escaped"), "dir");
      expect(
        await resolveFunctionConfig({ root, slug: "escaped", overrides: {}, fs: nodeFileSystem }),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("fails closed when a static wildcard tree contains a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "stack-functions-resolver-static-"));
    const outside = await mkdtemp(join(tmpdir(), "stack-functions-resolver-static-outside-"));
    try {
      const canonicalRoot = await realpath(root);
      const functionRoot = join(root, "hello");
      const publicRoot = join(functionRoot, "public");
      await mkdir(publicRoot, { recursive: true });
      await writeFile(join(functionRoot, "index.ts"), "export default 1");
      await writeFile(join(publicRoot, "ok.txt"), "ok");
      expect(
        await resolveFunctionConfig({
          root,
          slug: "hello",
          overrides: { hello: { static_files: ["public/*.txt"] } },
          fs: nodeFileSystem,
        }),
      ).toMatchObject({ staticFiles: [join(canonicalRoot, "hello", "public", "*.txt")] });
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(join(outside, "secret.txt"), join(publicRoot, "link.txt"));
      expect(
        await resolveFunctionConfig({
          root,
          slug: "hello",
          overrides: { hello: { static_files: ["public/*.txt"] } },
          fs: nodeFileSystem,
        }),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
