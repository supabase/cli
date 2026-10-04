import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveArtifact } from "../Artifacts.ts";
import { postgres } from "../Commands.ts";
import {
  makeArtifactStore,
  type ArtifactRequest,
  type ArtifactSource,
} from "../preparation/ArtifactStore.ts";
import { PreparationError } from "../preparation/Errors.ts";
import * as CommandRunner from "./CommandRunner.ts";
import { noContainerClaims } from "../../tests/claims.ts";

const target =
  process.platform === "darwin" && process.arch === "arm64"
    ? "darwin-arm64"
    : process.platform === "linux" && process.arch === "x64"
      ? "linux-amd64"
      : process.platform === "linux" && process.arch === "arm64"
        ? "linux-arm64"
        : undefined;

/**
 * Publishes a trivial fixture in place of the real postgres artifact, at the exact cache key and
 * digest `CommandRunner`'s own native launch resolves: its later `useNativeArtifact` call then
 * hits this cached generation instead of downloading and running the real, much larger postgres
 * distribution, whose first execution after a fresh extraction costs several additional seconds
 * on top of the download (one-time code-signature validation of a freshly written binary).
 */
const prepareDatabaseArtifact = Effect.fn(function* (cacheRoot: string) {
  if (target === undefined) return yield* Effect.fail("Unsupported test platform");
  const fs = yield* FileSystem.FileSystem;
  const { releaseVersion, natives, requiredRuntimePaths, executablePath } = yield* resolveArtifact({
    service: "database",
  });
  const request: ArtifactRequest = {
    key: `slim-services/postgres/${releaseVersion}/${target}`,
    requiredRuntimePaths,
    executablePath,
  };
  const digest = natives[target].archive;
  const source: ArtifactSource = {
    checksum: () => Effect.succeed(digest),
    materialize: (_request, destination) =>
      Effect.gen(function* () {
        for (const relative of requiredRuntimePaths) {
          const file = `${destination}/${relative}`;
          yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
          yield* fs.writeFileString(file, `#!${process.execPath}\nprocess.exit(0);\n`);
          yield* fs.chmod(file, 0o755);
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new PreparationError({
              message: `Unable to write database command fixture: ${cause.message}`,
              cause,
            }),
        ),
      ),
  };
  const store = yield* makeArtifactStore({ cacheRoot, source });
  yield* store.prepare(request);
});

it.live.skipIf(target === undefined || process.platform === "win32")(
  "retries failed native workload cleanup when the stack runner is cleaned up",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-runner-cleanup-" });
        const cacheRoot = path.join(root, "cache");
        yield* prepareDatabaseArtifact(cacheRoot);
        let isRunningCalls = 0;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const child = yield* delegate.spawn(command);
            if (
              !ChildProcess.isStandardCommand(command) ||
              !command.args.some((argument) => argument.includes("native-launcher"))
            )
              return child;
            return ChildProcessSpawner.makeHandle({
              pid: child.pid,
              exitCode: child.exitCode,
              isRunning: Effect.suspend(() => {
                isRunningCalls += 1;
                if (isRunningCalls <= 3)
                  return Effect.fail(
                    systemError({
                      _tag: "Unknown",
                      module: "test",
                      method: "isRunning",
                      description: "injected transient probe failure",
                    }),
                  );
                return child.isRunning;
              }),
              kill: child.kill,
              stdin: child.stdin,
              stdout: child.stdout,
              stderr: child.stderr,
              all: child.all,
              getInputFd: child.getInputFd,
              getOutputFd: child.getOutputFd,
              unref: child.unref,
            });
          }),
        );
        const layer = CommandRunner.layer({
          claims: noContainerClaims,
          stackId: "native-cleanup-test",
          root,
          cacheRoot,
          runtime: "native",
        }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));
        const runner = Context.get(yield* Layer.build(layer), CommandRunner.Service);
        const result = yield* runner
          .run({
            command: {
              type: "postgres",
              command: postgres.psql({ major: 17 }),
              args: ["--version"],
              env: {},
              stdin: false,
            },
            stdin: Stream.empty,
            stdout: () => Effect.void,
            stderr: () => Effect.void,
          })
          .pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        expect(isRunningCalls).toBe(2);
        const firstCleanup = yield* runner.cleanup.pipe(Effect.exit);
        expect(firstCleanup._tag).toBe("Failure");
        expect(isRunningCalls).toBe(3);
        yield* runner.cleanup;
        expect(isRunningCalls).toBe(4);
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    ),
);
