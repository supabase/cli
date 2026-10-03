import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { create, discover } from "./effect.ts";
import { deriveStackId, resolveStackIdentity } from "./identity/Identity.ts";
import * as StackNamespace from "./StackNamespace.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

/** Seeds a container claim for a not-yet-created stack id, as an orphaned claim would be found. */
const seedContainerClaim = (
  stateRoot: string,
  id: string,
  containerId: string,
  daemonId?: string,
) =>
  Effect.scoped(
    Layer.build(StackNamespace.layer({ root: stateRoot })).pipe(
      Effect.flatMap((context) =>
        Context.get(context, StackNamespace.Service).claim(id, {
          kind: "container",
          id: containerId,
          ...(daemonId === undefined ? {} : { daemonId }),
        }),
      ),
    ),
  );

it.live(
  "removes a stack it just registered when the owner fails to launch, and lets a retry succeed",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-create-rollback-" });
      const binDir = path.join(root, "bin");
      yield* fs.makeDirectory(binDir, { recursive: true });
      const dockerShim = path.join(binDir, "docker");
      yield* fs.writeFileString(
        dockerShim,
        "#!/bin/sh\necho 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2\nexit 1\n",
      );
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

      const options = {
        projectRoot: root,
        stateRoot: `${root}/state`,
        cacheRoot: `${root}/cache`,
        runtime: "docker",
      } satisfies Parameters<typeof create>[0];
      const identity = yield* resolveStackIdentity(options);
      const id = yield* deriveStackId(identity);
      // An orphaned claim from a never-fully-registered prior attempt, found by this owner's
      // startup reconcile before it finishes registering.
      yield* seedContainerClaim(options.stateRoot, id, "rollback0000000000000000000000001");

      const launchFailure = yield* Effect.flip(create({ ...options, startOwner: true }));
      expect(launchFailure.message).toContain("Cannot connect to the Docker daemon");

      expect(yield* discover({ stateRoot: options.stateRoot })).toEqual([]);
      const stateFileExit = yield* Effect.exit(
        fs.access(path.join(options.stateRoot, id, "state.json")),
      );
      expect(Exit.isFailure(stateFileExit)).toBe(true);

      const retried = yield* create({ ...options, runtime: "native" });
      expect(retried.id).toBe(id);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("removes a stack it just registered when its owner launch is interrupted", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-create-interrupt-" });
    // The shim signals through a FIFO once the owner's startup reconcile is running, then blocks.
    const started = path.join(root, "sweep-started");
    yield* Effect.scoped(
      spawner
        .spawn(ChildProcess.make("mkfifo", [started]))
        .pipe(Effect.flatMap((child) => child.exitCode)),
    );
    const binDir = path.join(root, "bin");
    yield* fs.makeDirectory(binDir, { recursive: true });
    const dockerShim = path.join(binDir, "docker");
    yield* fs.writeFileString(
      dockerShim,
      // The leading check strips the pinned `--host <endpoint>` prefix every invocation now
      // carries (fixed below via DOCKER_HOST), so "$1" below still sees the real command.
      `#!/bin/sh\nif [ "$1" = "--host" ]; then shift 2; fi\nif [ "$1" = "rm" ]; then echo started > '${started}'; exec sleep 60; fi\nif [ "$1" = "info" ]; then echo fake-daemon-id; fi\nexit 0\n`,
    );
    yield* fs.chmod(dockerShim, 0o755);
    // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the detached host subprocess inherits PATH; this is not application config.
    const originalPath = process.env.PATH;
    // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above.
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    // Fixes the pinned endpoint to a dummy socket, so resolving it never needs `context show`/
    // `context inspect`, which this minimal shim doesn't answer.
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

    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "docker",
    } satisfies Parameters<typeof create>[0];
    const identity = yield* resolveStackIdentity(options);
    const id = yield* deriveStackId(identity);
    // Recorded against the daemon this reconcile run will match: the engine is reachable and
    // identifiable here, so the interrupted launch's own rollback is what's under test.
    yield* seedContainerClaim(
      options.stateRoot,
      id,
      "interrupt0000000000000000000000001",
      "fake-daemon-id",
    );
    const creating = yield* create({ ...options, startOwner: true }).pipe(Effect.forkChild);
    yield* fs.readFileString(started);
    yield* Fiber.interrupt(creating);

    expect(yield* discover({ stateRoot: options.stateRoot })).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
