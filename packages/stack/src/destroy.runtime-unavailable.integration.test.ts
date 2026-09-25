import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";
import { create, discover } from "./effect.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

const shimDocker = Effect.fn("shimDocker")(function* (root: string, script: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binDir = path.join(root, "bin");
  yield* fs.makeDirectory(binDir, { recursive: true });
  const dockerShim = path.join(binDir, "docker");
  yield* fs.writeFileString(dockerShim, script);
  yield* fs.chmod(dockerShim, 0o755);
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the detached host subprocess inherits PATH; this is not application config.
  const originalPath = process.env.PATH;
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above.
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- restores the mutation made above.
      process.env.PATH = originalPath;
    }),
  );
});

it.live(
  "removes a stack's registration and data when destroy finds no owner and its engine is unreachable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-offline-" });
      yield* shimDocker(
        root,
        "#!/bin/sh\necho 'Cannot connect to the Docker daemon at tcp://127.0.0.1:1. Is the docker daemon running?' >&2\nexit 1\n",
      );

      const options = {
        projectRoot: root,
        stateRoot: `${root}/state`,
        cacheRoot: `${root}/cache`,
        runtime: "docker",
      } satisfies Parameters<typeof create>[0];
      const stack = yield* create(options);
      const dataRoot = `${options.stateRoot}/${stack.id}/data`;
      yield* fs.makeDirectory(`${dataRoot}/db-instance`, { recursive: true });
      yield* fs.writeFileString(
        `${dataRoot}/db-instance/.supabase-database-storage.json`,
        `{"backend":"docker","volume":"supabase-db-0123456789abcdef","namespace":"instance-${stack.id}-db-instance","cacheNamespace":"cache-${"0".repeat(32)}","daemonId":"daemon","initialized":true}`,
      );
      const resolvedDataRoot = yield* fs.realPath(dataRoot);

      const result = yield* stack.destroy;
      expect(result).toEqual({
        runtimeCleanup: "skipped",
        engine: "docker",
        cleanupCommands: [
          `docker rm --force $(docker ps --all --quiet --no-trunc --filter 'label=com.supabase.stack=${stack.id}' --filter 'label=com.supabase.stack-root=${resolvedDataRoot}')`,
          expect.stringMatching(
            new RegExp(
              `^docker run --rm --mount 'type=volume,src=supabase-db-0123456789abcdef,dst=/store' '[^']+' /bin/sh -c 'rm -rf /store/instance-${stack.id}-db-instance'$`,
              "u",
            ),
          ),
        ],
      });

      expect(yield* discover({ stateRoot: options.stateRoot })).toEqual([]);
      const stackDirExit = yield* Effect.exit(fs.access(`${options.stateRoot}/${stack.id}`));
      expect(Exit.isFailure(stackDirExit)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("removes a stack offline when Windows reports its Docker daemon pipe is missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-windows-" });
    yield* shimDocker(
      root,
      `#!/bin/sh\necho 'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/json": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.' >&2\nexit 1\n`,
    );
    const stateRoot = `${root}/state`;
    const stack = yield* create({
      projectRoot: root,
      stateRoot,
      cacheRoot: `${root}/cache`,
      runtime: "docker",
    });

    const result = yield* stack.destroy;

    expect(result.runtimeCleanup).toBe("skipped");
    expect(yield* discover({ stateRoot })).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("removes a stack offline when its engine CLI is not installed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-no-cli-" });
    const stateRoot = `${root}/state`;
    const stack = yield* create({
      projectRoot: root,
      stateRoot,
      cacheRoot: `${root}/cache`,
      runtime: "docker",
    });
    yield* fs.makeDirectory(`${root}/empty-bin`);
    // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the detached host subprocess inherits PATH; this is not application config.
    const originalPath = process.env.PATH;
    // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above.
    process.env.PATH = `${root}/empty-bin`;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- restores the mutation made above.
        process.env.PATH = originalPath;
      }),
    );

    const result = yield* stack.destroy;

    expect(result.runtimeCleanup).toBe("skipped");
    expect(yield* discover({ stateRoot })).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("keeps a stack registered when its container engine rejects the listing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-permission-" });
    yield* shimDocker(
      root,
      "#!/bin/sh\necho 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock' >&2\nexit 1\n",
    );

    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "docker",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);

    const destroyFailure = yield* Effect.flip(stack.destroy);
    expect(destroyFailure.message).toContain("permission denied");

    expect(yield* discover({ stateRoot: options.stateRoot })).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("keeps a stack registered when its container engine is reachable but cleanup fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-cleanup-failure-" });
    yield* shimDocker(
      root,
      [
        "#!/bin/sh",
        'if [ "$1" = "ps" ]; then',
        '  echo "abc123def456"',
        "  exit 0",
        "fi",
        'if [ "$1" = "rm" ]; then',
        "  echo 'docker: Error response from daemon: container removal failed' >&2",
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );

    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "docker",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);

    const destroyFailure = yield* Effect.flip(stack.destroy);
    expect(destroyFailure.message).toContain("container removal failed");

    expect(yield* discover({ stateRoot: options.stateRoot })).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
