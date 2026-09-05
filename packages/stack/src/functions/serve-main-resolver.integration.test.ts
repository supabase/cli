// oxlint-disable effecttsgo/async-function -- test exercises the Promise-based resolver boundary.
// oxlint-disable effecttsgo/node-builtin-import -- Node filesystem fixtures own their temporary test root.
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
import {
  createWorkerServicePathResolver,
  packageJsonContainedFor,
  resolveFunctionConfig,
  type FunctionFileSystem,
} from "./serve-main-resolver.ts";

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

describe("Edge Runtime worker service paths", () => {
  it("keeps stable identities for functions that share a source directory", () => {
    let nextWorker = 0;
    const resolveWorkerPath = createWorkerServicePathResolver(
      () => `/tmp/supabase-worker-${++nextWorker}`,
    );
    const alpha = {
      entrypointPath: "/functions/shared/alpha.ts",
      importMapPath: "",
      staticFiles: [],
      verifyJWT: true,
    };
    const beta = { ...alpha, entrypointPath: "/functions/shared/beta.ts" };

    expect(resolveWorkerPath("alpha", alpha)).toBe("/functions/shared");
    expect(resolveWorkerPath("beta", beta)).toBe("/tmp/supabase-worker-1");
    expect(resolveWorkerPath("alpha", alpha)).toBe("/functions/shared");
    expect(
      resolveWorkerPath("isolated", { ...alpha, entrypointPath: "/functions/isolated/index.ts" }),
    ).toBe("/functions/isolated");
  });
});

describe("Edge Runtime request-time function resolver", () => {
  it("resolves current filesystem paths for create/edit/delete", async () => {
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
      await writeFile(join(hello, "package.json"), "{}");
      expect(
        await packageJsonContainedFor({
          root,
          config: { ...defaults!, importMapPath: "" },
          fs: nodeFileSystem,
        }),
      ).toBe(true);

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

  it("normalizes persisted empty entrypoint settings to index.ts", async () => {
    const root = await mkdtemp(join(tmpdir(), "stack-functions-resolver-empty-entrypoint-"));
    try {
      const functionRoot = join(root, "hello");
      await mkdir(functionRoot, { recursive: true });
      await writeFile(join(functionRoot, "index.ts"), "export default 1");
      await writeFile(join(functionRoot, "deno.json"), "{}");
      const canonicalRoot = await realpath(root);

      const config = await resolveFunctionConfig({
        root,
        slug: "hello",
        overrides: {
          hello: {
            enabled: true,
            verify_jwt: false,
            import_map: "",
            entrypoint: "",
            static_files: [],
            env: {},
          },
        },
        fs: nodeFileSystem,
      });

      expect(config).toMatchObject({
        entrypointPath: join(canonicalRoot, "hello", "index.ts"),
        importMapPath: join(canonicalRoot, "hello", "deno.json"),
        verifyJWT: false,
      });

      await writeFile(join(functionRoot, "custom.ts"), "export default 2");
      const explicit = await resolveFunctionConfig({
        root,
        slug: "hello",
        overrides: {
          hello: {
            enabled: true,
            verify_jwt: false,
            import_map: "",
            entrypointPath: "custom.ts",
            entrypoint: "index.ts",
            static_files: [],
            env: {},
          },
        },
        fs: nodeFileSystem,
      });
      expect(explicit?.entrypointPath).toBe(join(canonicalRoot, "hello", "custom.ts"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts an absolute entrypoint inside the functions root without a slug directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "stack-functions-resolver-absolute-entrypoint-"));
    try {
      const entrypoint = join(root, "legacy", "index.ts");
      await mkdir(join(root, "legacy"), { recursive: true });
      await writeFile(entrypoint, "export default 1");

      await expect(
        resolveFunctionConfig({
          root,
          slug: "hello",
          overrides: { hello: { entrypointPath: entrypoint } },
          fs: nodeFileSystem,
        }),
      ).resolves.toMatchObject({
        entrypointPath: entrypoint,
        importMapPath: "",
        verifyJWT: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies global defaults to newly discovered functions while preserving overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "stack-functions-resolver-defaults-"));
    try {
      const hello = join(root, "hello");
      const created = join(root, "created");
      const canonicalRoot = await realpath(root);
      await mkdir(hello, { recursive: true });
      await mkdir(created, { recursive: true });
      await writeFile(join(hello, "index.ts"), "export default 1");
      await writeFile(join(created, "index.ts"), "export default 2");
      await writeFile(join(root, "shared-deno.json"), "{}");

      const defaults = {
        verify_jwt: false,
        import_map_root: "shared-deno.json",
      };
      const overrides = {
        $default: defaults,
        hello: { verify_jwt: true },
      };

      expect(
        await resolveFunctionConfig({ root, slug: "created", overrides, fs: nodeFileSystem }),
      ).toMatchObject({
        verifyJWT: false,
        importMapPath: join(canonicalRoot, "shared-deno.json"),
      });
      expect(
        await resolveFunctionConfig({ root, slug: "hello", overrides, fs: nodeFileSystem }),
      ).toMatchObject({
        verifyJWT: true,
        importMapPath: join(canonicalRoot, "shared-deno.json"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a closed per-function import map relative to that function", async () => {
    const root = await mkdtemp(join(tmpdir(), "stack-functions-resolver-import-map-"));
    try {
      const hello = join(root, "hello");
      await mkdir(hello, { recursive: true });
      await writeFile(join(hello, "index.ts"), "export default 1");
      await writeFile(join(root, "shared-deno.json"), "{}");
      await writeFile(join(hello, "custom-deno.json"), "{}");

      const canonicalRoot = await realpath(root);
      await expect(
        resolveFunctionConfig({
          root,
          slug: "hello",
          overrides: {
            $default: { import_map_root: "shared-deno.json" },
            hello: { import_map: "custom-deno.json" },
          },
          fs: nodeFileSystem,
        }),
      ).resolves.toMatchObject({
        importMapPath: join(canonicalRoot, "hello", "custom-deno.json"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a symlinked functions root while enforcing canonical descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "stack-functions-resolver-root-link-"));
    try {
      const canonical = join(root, "canonical");
      const configured = join(root, "configured");
      await mkdir(join(canonical, "hello"), { recursive: true });
      await writeFile(join(canonical, "hello", "index.ts"), "export default 1");
      await symlink(canonical, configured, "dir");
      const found = await resolveFunctionConfig({
        root: configured,
        slug: "hello",
        overrides: {},
        fs: nodeFileSystem,
      });
      expect(found?.entrypointPath).toBe(join(await realpath(canonical), "hello", "index.ts"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows package.json discovery under a symlinked functions root", async () => {
    const root = await mkdtemp(join(tmpdir(), "stack-functions-resolver-package-root-link-"));
    try {
      const canonical = join(root, "canonical");
      const configured = join(root, "configured");
      const functionRoot = join(canonical, "hello");
      await mkdir(functionRoot, { recursive: true });
      await writeFile(join(functionRoot, "index.ts"), "export default 1");
      await writeFile(join(functionRoot, "package.json"), "{}");
      await symlink(canonical, configured, "dir");
      const config = await resolveFunctionConfig({
        root: configured,
        slug: "hello",
        overrides: {},
        fs: nodeFileSystem,
      });
      expect(config).toBeDefined();
      expect(
        await packageJsonContainedFor({
          root: configured,
          config: { ...config!, importMapPath: "" },
          fs: nodeFileSystem,
        }),
      ).toBe(true);
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
      await writeFile(join(outside, "package.json"), "{}");
      await symlink(join(outside, "package.json"), join(functionRoot, "package.json"));
      const config = {
        entrypointPath: join(functionRoot, "index.ts"),
        importMapPath: "",
        staticFiles: [],
        verifyJWT: true,
      };
      expect(await packageJsonContainedFor({ root, config, fs: nodeFileSystem })).toBe(false);
      await unlink(join(functionRoot, "package.json"));
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
