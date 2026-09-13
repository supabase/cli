// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem.stat follows symlinks; the resolver fixture must expose lstat.
import { lstat } from "node:fs/promises";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  createWorkerServicePathResolver,
  packageJsonContainedFor,
  resolveFunctionConfig,
  type FunctionFileSystem,
  FunctionFileSystemError,
} from "./serve-main-resolver.ts";
const makeNodeFileSystem = (fs: FileSystem.FileSystem): FunctionFileSystem => ({
  lstat: (path) =>
    Effect.tryPromise({
      try: () => lstat(path),
      catch: (cause) => new FunctionFileSystemError({ cause }),
    }).pipe(
      Effect.map((info) => ({
        isDirectory: info.isDirectory(),
        isFile: info.isFile(),
        isSymbolicLink: info.isSymbolicLink(),
      })),
    ),
  realPath: (path) =>
    fs.realPath(path).pipe(Effect.mapError((cause) => new FunctionFileSystemError({ cause }))),
  readDirectory: (path) =>
    fs.readDirectory(path).pipe(Effect.mapError((cause) => new FunctionFileSystemError({ cause }))),
});
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
  it.live("resolves current filesystem paths for create/delete", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nodeFileSystem = makeNodeFileSystem(fs);
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-functions-resolver-" });
      const hello = path.join(root, "hello");
      yield* fs.makeDirectory(hello, { recursive: true });
      yield* fs.writeFileString(path.join(hello, "index.ts"), "export default 1");
      yield* fs.writeFileString(path.join(hello, "deno.json"), "{}");
      const canonicalRoot = yield* fs.realPath(root);
      const defaults = yield* resolveFunctionConfig({
        root,
        slug: "hello",
        overrides: {},
        fs: nodeFileSystem,
      });
      expect(defaults).toMatchObject({
        entrypointPath: path.join(canonicalRoot, "hello", "index.ts"),
        importMapPath: path.join(canonicalRoot, "hello", "deno.json"),
        verifyJWT: true,
      });
      const created = path.join(root, "new-function");
      yield* fs.makeDirectory(created);
      yield* fs.writeFileString(path.join(created, "index.ts"), "export default 3");
      expect(
        yield* resolveFunctionConfig({
          root,
          slug: "new-function",
          overrides: {},
          fs: nodeFileSystem,
        }),
      ).toMatchObject({
        verifyJWT: true,
        entrypointPath: path.join(canonicalRoot, "new-function", "index.ts"),
      });
      yield* fs.remove(path.join(hello, "index.ts"));
      expect(
        yield* resolveFunctionConfig({ root, slug: "hello", overrides: {}, fs: nodeFileSystem }),
      ).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("discovers a contained package.json for a function without an import map", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nodeFileSystem = makeNodeFileSystem(fs);
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-resolver-package-discovery-",
      });
      const hello = path.join(root, "hello");
      yield* fs.makeDirectory(hello, { recursive: true });
      yield* fs.writeFileString(path.join(hello, "index.ts"), "export default 1");
      yield* fs.writeFileString(path.join(hello, "package.json"), "{}");
      const config = yield* resolveFunctionConfig({
        root,
        slug: "hello",
        overrides: {},
        fs: nodeFileSystem,
      });
      expect(config).toBeDefined();
      expect(
        yield* packageJsonContainedFor({
          root,
          config: { ...config!, importMapPath: "" },
          fs: nodeFileSystem,
        }),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("normalizes persisted empty entrypoint settings to index.ts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nodeFileSystem = makeNodeFileSystem(fs);
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-resolver-empty-entrypoint-",
      });
      const functionRoot = path.join(root, "hello");
      yield* fs.makeDirectory(functionRoot, { recursive: true });
      yield* fs.writeFileString(path.join(functionRoot, "index.ts"), "export default 1");
      yield* fs.writeFileString(path.join(functionRoot, "deno.json"), "{}");
      const canonicalRoot = yield* fs.realPath(root);
      const config = yield* resolveFunctionConfig({
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
        entrypointPath: path.join(canonicalRoot, "hello", "index.ts"),
        importMapPath: path.join(canonicalRoot, "hello", "deno.json"),
        verifyJWT: false,
      });
      yield* fs.writeFileString(path.join(functionRoot, "custom.ts"), "export default 2");
      const explicit = yield* resolveFunctionConfig({
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
      expect(explicit?.entrypointPath).toBe(path.join(canonicalRoot, "hello", "custom.ts"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("accepts an absolute entrypoint inside the functions root without a slug directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nodeFileSystem = makeNodeFileSystem(fs);
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-resolver-absolute-entrypoint-",
      });
      const entrypoint = path.join(root, "legacy", "index.ts");
      yield* fs.makeDirectory(path.join(root, "legacy"), { recursive: true });
      yield* fs.writeFileString(entrypoint, "export default 1");
      expect(
        yield* resolveFunctionConfig({
          root,
          slug: "hello",
          overrides: { hello: { entrypointPath: entrypoint } },
          fs: nodeFileSystem,
        }),
      ).toMatchObject({
        entrypointPath: entrypoint,
        importMapPath: "",
        verifyJWT: true,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("applies global defaults to newly discovered functions while preserving overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nodeFileSystem = makeNodeFileSystem(fs);
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-resolver-defaults-",
      });
      const hello = path.join(root, "hello");
      const created = path.join(root, "created");
      const canonicalRoot = yield* fs.realPath(root);
      yield* fs.makeDirectory(hello, { recursive: true });
      yield* fs.makeDirectory(created, { recursive: true });
      yield* fs.writeFileString(path.join(hello, "index.ts"), "export default 1");
      yield* fs.writeFileString(path.join(created, "index.ts"), "export default 2");
      yield* fs.writeFileString(path.join(root, "shared-deno.json"), "{}");
      const defaults = {
        verify_jwt: false,
        import_map_root: "shared-deno.json",
      };
      const overrides = {
        $default: defaults,
        hello: { verify_jwt: true },
      };
      expect(
        yield* resolveFunctionConfig({ root, slug: "created", overrides, fs: nodeFileSystem }),
      ).toMatchObject({
        verifyJWT: false,
        importMapPath: path.join(canonicalRoot, "shared-deno.json"),
      });
      expect(
        yield* resolveFunctionConfig({ root, slug: "hello", overrides, fs: nodeFileSystem }),
      ).toMatchObject({
        verifyJWT: true,
        importMapPath: path.join(canonicalRoot, "shared-deno.json"),
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("keeps a closed per-function import map relative to that function", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nodeFileSystem = makeNodeFileSystem(fs);
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-resolver-import-map-",
      });
      const hello = path.join(root, "hello");
      yield* fs.makeDirectory(hello, { recursive: true });
      yield* fs.writeFileString(path.join(hello, "index.ts"), "export default 1");
      yield* fs.writeFileString(path.join(root, "shared-deno.json"), "{}");
      yield* fs.writeFileString(path.join(hello, "custom-deno.json"), "{}");
      const canonicalRoot = yield* fs.realPath(root);
      expect(
        yield* resolveFunctionConfig({
          root,
          slug: "hello",
          overrides: {
            $default: { import_map_root: "shared-deno.json" },
            hello: { import_map: "custom-deno.json" },
          },
          fs: nodeFileSystem,
        }),
      ).toMatchObject({
        importMapPath: path.join(canonicalRoot, "hello", "custom-deno.json"),
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("accepts a symlinked functions root while enforcing canonical descendants", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nodeFileSystem = makeNodeFileSystem(fs);
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-resolver-root-link-",
      });
      const canonical = path.join(root, "canonical");
      const configured = path.join(root, "configured");
      yield* fs.makeDirectory(path.join(canonical, "hello"), { recursive: true });
      yield* fs.writeFileString(path.join(canonical, "hello", "index.ts"), "export default 1");
      yield* fs.symlink(canonical, configured);
      const found = yield* resolveFunctionConfig({
        root: configured,
        slug: "hello",
        overrides: {},
        fs: nodeFileSystem,
      });
      expect(found?.entrypointPath).toBe(
        path.join(yield* fs.realPath(canonical), "hello", "index.ts"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("allows package.json discovery under a symlinked functions root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nodeFileSystem = makeNodeFileSystem(fs);
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-resolver-package-root-link-",
      });
      const canonical = path.join(root, "canonical");
      const configured = path.join(root, "configured");
      const functionRoot = path.join(canonical, "hello");
      yield* fs.makeDirectory(functionRoot, { recursive: true });
      yield* fs.writeFileString(path.join(functionRoot, "index.ts"), "export default 1");
      yield* fs.writeFileString(path.join(functionRoot, "package.json"), "{}");
      yield* fs.symlink(canonical, configured);
      const config = yield* resolveFunctionConfig({
        root: configured,
        slug: "hello",
        overrides: {},
        fs: nodeFileSystem,
      });
      expect(config).toBeDefined();
      expect(
        yield* packageJsonContainedFor({
          root: configured,
          config: { ...config!, importMapPath: "" },
          fs: nodeFileSystem,
        }),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("requires an absolute root and rejects traversal and symlink escapes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nodeFileSystem = makeNodeFileSystem(fs);
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-functions-resolver-paths-" });
      const outside = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-resolver-outside-",
      });
      yield* fs.makeDirectory(path.join(root, "safe"));
      yield* fs.writeFileString(path.join(root, "safe", "index.ts"), "export default 1");
      yield* fs.writeFileString(path.join(outside, "index.ts"), "export default 2");
      expect(
        yield* resolveFunctionConfig({ root: "", slug: "safe", overrides: {}, fs: nodeFileSystem }),
      ).toBeUndefined();
      expect(
        yield* resolveFunctionConfig({
          root,
          slug: "safe",
          overrides: { safe: { entrypoint: "../outside.ts" } },
          fs: nodeFileSystem,
        }),
      ).toBeUndefined();
      yield* fs.symlink(outside, path.join(root, "escaped"));
      expect(
        yield* resolveFunctionConfig({ root, slug: "escaped", overrides: {}, fs: nodeFileSystem }),
      ).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("fails closed when a static wildcard tree contains a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nodeFileSystem = makeNodeFileSystem(fs);
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-resolver-static-",
      });
      const outside = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-resolver-static-outside-",
      });
      const canonicalRoot = yield* fs.realPath(root);
      const functionRoot = path.join(root, "hello");
      const publicRoot = path.join(functionRoot, "public");
      yield* fs.makeDirectory(publicRoot, { recursive: true });
      yield* fs.writeFileString(path.join(functionRoot, "index.ts"), "export default 1");
      yield* fs.writeFileString(path.join(outside, "package.json"), "{}");
      yield* fs.symlink(
        path.join(outside, "package.json"),
        path.join(functionRoot, "package.json"),
      );
      const config = {
        entrypointPath: path.join(functionRoot, "index.ts"),
        importMapPath: "",
        staticFiles: [],
        verifyJWT: true,
      };
      expect(yield* packageJsonContainedFor({ root, config, fs: nodeFileSystem })).toBe(false);
      yield* fs.remove(path.join(functionRoot, "package.json"));
      yield* fs.writeFileString(path.join(publicRoot, "ok.txt"), "ok");
      expect(
        yield* resolveFunctionConfig({
          root,
          slug: "hello",
          overrides: { hello: { static_files: ["public/*.txt"] } },
          fs: nodeFileSystem,
        }),
      ).toMatchObject({ staticFiles: [path.join(canonicalRoot, "hello", "public", "*.txt")] });
      yield* fs.writeFileString(path.join(outside, "secret.txt"), "secret");
      yield* fs.symlink(path.join(outside, "secret.txt"), path.join(publicRoot, "link.txt"));
      expect(
        yield* resolveFunctionConfig({
          root,
          slug: "hello",
          overrides: { hello: { static_files: ["public/*.txt"] } },
          fs: nodeFileSystem,
        }),
      ).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
