import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { systemError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { postgres } from "../Tools.ts";
import * as ToolRunner from "./ToolRunner.ts";

it.live.skipIf(process.platform === "win32")(
  "retries failed native workload cleanup when the stack runner is cleaned up",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-runner-cleanup-" });
        const cacheRoot = path.join(root, "cache");
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
        const layer = ToolRunner.layer({
          stackId: "native-cleanup-test",
          root,
          cacheRoot,
          runtime: "native",
        }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));
        const runner = Context.get(yield* Layer.build(layer), ToolRunner.Service);
        const result = yield* runner
          .run({
            tool: postgres.psql({ major: 17 }),
            args: ["--version"],
            env: {},
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
