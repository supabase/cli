import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { create, discover } from "./effect.ts";
import * as StackNamespace from "./StackNamespace.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

// Strips the pinned `--host <endpoint>` prefix every invocation now carries, so a shim's own
// `"$1"` checks see the real command unchanged; `DOCKER_HOST` below makes that prefix constant.
const stripPinPrefix = 'if [ "$1" = "--host" ]; then shift 2; fi\n';

const shimDocker = Effect.fn("shimDocker")(function* (root: string, script: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binDir = path.join(root, "bin");
  yield* fs.makeDirectory(binDir, { recursive: true });
  const dockerShim = path.join(binDir, "docker");
  yield* fs.writeFileString(
    dockerShim,
    script.replace("#!/bin/sh\n", `#!/bin/sh\n${stripPinPrefix}`),
  );
  yield* fs.chmod(dockerShim, 0o755);
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the detached host subprocess inherits PATH; this is not application config.
  const originalPath = process.env.PATH;
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above.
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  // Fixes the pinned endpoint to a dummy socket, so resolving it never needs `context show`/
  // `context inspect`, which these minimal shims don't answer.
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above.
  const originalDockerHost = process.env.DOCKER_HOST;
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above.
  process.env.DOCKER_HOST = "unix:///var/run/shimmed-docker.sock";
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- restores the mutation made above.
      process.env.PATH = originalPath;
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- restores the mutation made above.
      if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- restores the mutation made above.
      else process.env.DOCKER_HOST = originalDockerHost;
    }),
  );
});

/** Opens the real namespace at `stateRoot`, bypassing any owner, to seed or read claims directly. */
const withNamespace = <A, E, R>(
  stateRoot: string,
  use: (state: StackNamespace.Interface) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Layer.build(StackNamespace.layer({ root: stateRoot })).pipe(
      Effect.flatMap((context) => use(Context.get(context, StackNamespace.Service))),
    ),
  );

/** Records a container claim as if a now-dead owner had created it before being interrupted. */
const seedContainerClaim = (
  stateRoot: string,
  id: string,
  containerId: string,
  daemonId?: string,
) =>
  withNamespace(stateRoot, (state) =>
    state.claim(id, {
      kind: "container",
      id: containerId,
      ...(daemonId === undefined ? {} : { daemonId }),
    }),
  );

const readClaimIds = (stateRoot: string, id: string) =>
  withNamespace(stateRoot, (state) => state.readClaims(id)).pipe(
    Effect.map((claims) => claims.map((claim) => claim.id)),
  );

it.live(
  "keeps a stack's registration and claims when destroy finds no owner and its engine is unreachable, then finishes the cleanup once a later owner can start",
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
      // Recorded against the daemon the engine will report once it is back: the second destroy
      // attempt below, once the engine is reachable again, is expected to finish the cleanup.
      yield* seedContainerClaim(
        options.stateRoot,
        stack.id,
        "offline0000000000000000000000000001",
        "fake-daemon-id",
      );

      const result = yield* stack.destroy;
      expect(result).toEqual({ runtimeCleanup: "skipped", engine: "docker" });
      expect(yield* discover({ stateRoot: options.stateRoot })).toHaveLength(1);
      expect(yield* readClaimIds(options.stateRoot, stack.id)).toEqual([
        "offline0000000000000000000000000001",
      ]);

      // The engine is back: destroy retried finishes the exact claimed cleanup automatically.
      yield* shimDocker(
        root,
        '#!/bin/sh\nif [ "$1" = "info" ]; then\n  echo \'fake-daemon-id\'\nfi\nexit 0\n',
      );
      const second = yield* stack.destroy;
      expect(second).toEqual({ runtimeCleanup: "complete" });
      expect(yield* discover({ stateRoot: options.stateRoot })).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  30_000,
);

it.live("keeps a stack registered when Windows reports its Docker daemon pipe is missing", () =>
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
    yield* seedContainerClaim(stateRoot, stack.id, "windows000000000000000000000000001");

    const result = yield* stack.destroy;

    expect(result.runtimeCleanup).toBe("skipped");
    expect(yield* discover({ stateRoot })).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("keeps a stack registered when its engine CLI is not installed", () =>
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
    yield* seedContainerClaim(stateRoot, stack.id, "nocli00000000000000000000000000001");
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
    expect(yield* discover({ stateRoot })).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("keeps a stack registered when Docker reports its API socket is missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-missing-socket-" });
    yield* shimDocker(
      root,
      "#!/bin/sh\necho 'failed to connect to the docker API at unix:///tmp/missing-docker.sock; check if the path is correct and if the daemon is running: dial unix /tmp/missing-docker.sock: connect: no such file or directory' >&2\nexit 1\n",
    );
    const stateRoot = `${root}/state`;
    const stack = yield* create({
      projectRoot: root,
      stateRoot,
      cacheRoot: `${root}/cache`,
      runtime: "docker",
    });
    yield* seedContainerClaim(stateRoot, stack.id, "socket0000000000000000000000000001");

    const result = yield* stack.destroy;

    expect(result.runtimeCleanup).toBe("skipped");
    expect(yield* discover({ stateRoot })).toHaveLength(1);
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
    yield* seedContainerClaim(options.stateRoot, stack.id, "permission00000000000000000000001");

    const destroyFailure = yield* Effect.flip(stack.destroy);
    // The socket itself refuses the owner's own startup, resolving its pinned engine target:
    // the owner never starts, so the stack stays registered for a later retry.
    expect(destroyFailure.message).toContain("permission denied");

    expect(yield* discover({ stateRoot: options.stateRoot })).toHaveLength(1);
    expect(yield* readClaimIds(options.stateRoot, stack.id)).toEqual([
      "permission00000000000000000000001",
    ]);
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
        'if [ "$1" = "rm" ]; then',
        "  echo 'docker: Error response from daemon: container removal failed' >&2",
        "  exit 1",
        "fi",
        // The daemon is reachable and identifiable; only the targeted removal fails.
        'if [ "$1" = "info" ]; then',
        "  echo 'fake-daemon-id'",
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
    // Recorded against the daemon this reconcile run will match: the engine is reachable and
    // identifiable here, so only the targeted removal itself is expected to fail.
    yield* seedContainerClaim(
      options.stateRoot,
      stack.id,
      "cleanupfail0000000000000000000001",
      "fake-daemon-id",
    );

    const destroyFailure = yield* Effect.flip(stack.destroy);
    expect(destroyFailure.message).toContain("container removal failed");

    expect(yield* discover({ stateRoot: options.stateRoot })).toHaveLength(1);
    // Cleanup authority never transferred away from the claim, so a later retry can still finish it.
    expect(yield* readClaimIds(options.stateRoot, stack.id)).toEqual([
      "cleanupfail0000000000000000000001",
    ]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
