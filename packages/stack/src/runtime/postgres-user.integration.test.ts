import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the current process's own uid/gid make the chown calls below harmless no-ops.
import { userInfo } from "node:os";
import {
  acquireNativeRuntimeRoot,
  handOverNativePostgresFiles,
  NativeRuntimeRootBase,
  nativeRuntimeRootPath,
  type PasswdEntry,
} from "./postgres-user.ts";

/**
 * Exercises only the symlink-rejection step of the step-down chown, which needs no privilege: the
 * handed-off targets are chowned to the current process's own uid/gid, a harmless no-op, so the
 * test runs identically whether or not it has root. The cross-uid chown itself (the part that
 * actually needs root) is verified by trace, not by this test: `handOverNativePostgresFiles`
 * chowns the confined HOME once, with `-R -P` and no nested paths as separate arguments (see
 * `chownRecursive` and its single call per target in `runtime/postgres-user.ts`).
 */
describe("handOverNativePostgresFiles", () => {
  it.live("refuses a confined HOME replaced by a symlink, without chowning through it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "postgres-user-symlink-" });
        const self = userInfo();
        const user: PasswdEntry = {
          name: self.username,
          uid: self.uid,
          gid: self.gid,
          home: self.homedir,
        };
        const dataPath = path.join(root, "data");
        const rootKeyPath = path.join(root, "pgsodium_root.key");
        const socketPath = path.join(root, "socket");
        const hbaPath = path.join(socketPath, "pg_hba.conf");
        const bundleRoot = path.join(root, "bundle");
        const executable = path.join(bundleRoot, "bin", "postgres");
        yield* fs.makeDirectory(dataPath, { recursive: true });
        yield* fs.makeDirectory(socketPath, { recursive: true });
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(rootKeyPath, "root-key");
        yield* fs.writeFileString(hbaPath, "local all all trust\n");
        yield* fs.writeFileString(executable, "#!/bin/sh\n");

        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "postgres-user-symlink-outside-",
        });
        const environmentHome = path.join(root, "home");
        yield* fs.symlink(outside, environmentHome);

        const failure = yield* handOverNativePostgresFiles(user, {
          dataPath,
          rootKeyPath,
          socketPath,
          hbaPath,
          runtimeRoot: root,
          bundleRoot,
          executable,
          environmentHome,
        }).pipe(Effect.flip);
        expect(failure.message).toContain("is a symlink");
        expect(yield* fs.readLink(environmentHome).pipe(Effect.isSuccess)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("acquireNativeRuntimeRoot", () => {
  it.live("refuses a pre-existing runtime root that is a symlink, leaving it untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({
          prefix: "native-runtime-root-symlink-",
        });
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "native-runtime-root-outside-",
        });
        const root = nativeRuntimeRootPath(path, base, process.getuid?.() ?? 0);
        yield* fs.symlink(outside, root);

        const failure = yield* acquireNativeRuntimeRoot().pipe(
          Effect.flip,
          Effect.provide(Layer.succeed(NativeRuntimeRootBase, base)),
        );
        expect(failure.message).toContain("is a symlink");
        expect(yield* fs.readLink(root)).toBe(outside);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "refuses a pre-existing runtime root that is group- or world-writable, leaving it untouched",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const base = yield* fs.makeTempDirectoryScoped({
            prefix: "native-runtime-root-writable-",
          });
          const root = nativeRuntimeRootPath(path, base, process.getuid?.() ?? 0);
          yield* fs.makeDirectory(root);
          // chmod, unlike the mkdir mode above, is never narrowed by the process umask.
          yield* fs.chmod(root, 0o707);

          const failure = yield* acquireNativeRuntimeRoot().pipe(
            Effect.flip,
            Effect.provide(Layer.succeed(NativeRuntimeRootBase, base)),
          );
          expect(failure.message).toContain("writable by group or others");
          expect((yield* fs.stat(root)).mode & 0o777).toBe(0o707);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "refuses a base beneath a group- or world-writable directory without the sticky bit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const shared = yield* fs.makeTempDirectoryScoped({
            prefix: "native-runtime-root-shared-",
          });
          yield* fs.chmod(shared, 0o777);
          const base = path.join(shared, "runtime");
          yield* fs.makeDirectory(base, { mode: 0o700 });

          const failure = yield* acquireNativeRuntimeRoot().pipe(
            Effect.flip,
            Effect.provide(Layer.succeed(NativeRuntimeRootBase, base)),
          );
          expect(failure.message).toContain("writable by group or others without the sticky bit");
          expect(yield* fs.exists(nativeRuntimeRootPath(path, base, process.getuid?.() ?? 0))).toBe(
            false,
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
