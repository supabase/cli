import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, Effect, FileSystem, Stream } from "effect";
import { resolveArtifact, slimImageMirrors } from "../Artifacts.ts";
import { makeContainerRuntime, type ContainerRuntime } from "../runtime/Container.ts";
import { cleanupStackVolumes } from "../../tests/docker-fixture.ts";
import { makeUploadsMount } from "./Storage.ts";

const writeMetadata = `import("/slim-runtime/app/node_modules/fs-xattr/index.js").then(({ setAttributeSync, getAttributeSync }) => {
  require("node:fs").writeFileSync("/mnt/object", "x");
  setAttributeSync("/mnt/object", "user.supabase.etag", "etag");
  console.log(getAttributeSync("/mnt/object", "user.supabase.etag").toString());
})`;

// TODO(storage-xattr): bind-mount uploads once Storage works without extended attributes.
describe("Storage uploads mount", () => {
  it.effect("keeps using an existing stack-volume without probing the directory", () =>
    Effect.gen(function* () {
      const container: ContainerRuntime = {
        prepare: () => Effect.die("prepared an image"),
        prepareImage: () => Effect.die("prepared an image"),
        launch: () => Effect.die("launched a container"),
        launchCommand: () => Effect.die("launched a probe"),
        stackVolumeExists: () => Effect.succeed(true),
      };
      const resolve = yield* makeUploadsMount({
        container,
        stackId: "stack",
        instanceId: "storage",
      });

      expect(yield* resolve({ filePath: "/uploads", readOnly: true })).toEqual({
        type: "stack-volume",
        source: "/uploads",
        target: "/mnt",
        readOnly: true,
      });
    }),
  );

  it.live(
    "gives Storage a mount that keeps object metadata and leaves no probe files behind",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "storage-uploads-" });
        const uploads = `${root}/uploads`;
        yield* fs.makeDirectory(uploads);
        const stackId = (yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4)).replaceAll(
          "-",
          "",
        );
        yield* cleanupStackVolumes(stackId, root);
        const container = yield* makeContainerRuntime({
          engine: "docker",
          root,
          imageMirrors: slimImageMirrors,
        });
        const resolve = yield* makeUploadsMount({ container, stackId, instanceId: "storage" });

        const mount = yield* resolve({ filePath: uploads, readOnly: false });
        expect(yield* fs.readDirectory(uploads)).toEqual([]);

        const { image } = yield* resolveArtifact({ service: "storage" });
        const output = yield* Effect.scoped(
          container
            .launchCommand({
              image,
              stackId,
              instanceId: "storage",
              env: {},
              entrypoint: "/slim-runtime/node/bin/node",
              args: ["-e", writeMetadata],
              mounts: [mount],
            })
            .pipe(
              Effect.flatMap((process) =>
                Effect.all(
                  [process.stdout.pipe(Stream.decodeText, Stream.mkString), process.exitCode],
                  { concurrency: "unbounded" },
                ),
              ),
            ),
        );
        expect(output).toEqual(["etag\n", 0]);
        expect(yield* fs.exists(`${uploads}/object`)).toBe(mount.type !== "stack-volume");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 180_000 },
  );
});
