import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";
import { create, discover } from "./effect.ts";
import { deriveStackId, resolveStackIdentity } from "./identity/Identity.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

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
        "#!/bin/sh\necho 'docker daemon unreachable' >&2\nexit 1\n",
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

      const launchFailure = yield* Effect.flip(create({ ...options, startOwner: true }));
      expect(launchFailure.message).toContain("docker daemon unreachable");

      expect(yield* discover({ stateRoot: options.stateRoot })).toEqual([]);
      const stackDirExit = yield* Effect.exit(fs.access(path.join(options.stateRoot, id)));
      expect(Exit.isFailure(stackDirExit)).toBe(true);

      const retried = yield* create({ ...options, runtime: "native" });
      expect(retried.id).toBe(id);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
