import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, FileSystem, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as State from "./State.ts";
import * as Owner from "./Owner.ts";
import * as ToolRunner from "./host/ToolRunner.ts";
import { bindControl, makeRuntime } from "./StackHost.ts";
import { shutdownOwner } from "../tests/owner.ts";

const stateFor = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );

it.live("retains saved state when destroy sweep fails and retries after engine recovery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-container-sweep-retry-" });
      const state = yield* stateFor(`${root}/state`);
      const saved = {
        id: "stack",
        runtime: "docker" as const,
        identity: { projectRoot: root, branchContext: "main", stackName: "sweep-retry" },
        instances: [],
        lifetime: "detached" as const,
        composition: { members: [], dependencies: [] },
        ports: [],
      };
      yield* state.save(saved);
      let listCalls = 0;
      const engine = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command) || command.command !== "docker")
          return Effect.die("Unexpected child process command");
        const isStackSweep =
          command.args[0] === "ps" &&
          command.args.includes(`label=com.supabase.stack=${saved.id}`) &&
          command.args.includes(`label=com.supabase.stack-root=${root}/data`);
        const failList = isStackSweep && ++listCalls === 1;
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(failList ? 1 : 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: failList
              ? Stream.succeed(new TextEncoder().encode("temporary engine failure"))
              : Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        );
      });
      const ownerLayer = Owner.layer({
        saved,
        root: `${root}/data`,
        cacheRoot: `${root}/cache`,
      }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(State.Service, state),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, engine),
          ),
        ),
      );
      const baseOwner = yield* Layer.build(ownerLayer).pipe(
        Effect.map((context) => Context.get(context, Owner.Service)),
      );
      const owner = baseOwner;
      const acquired = yield* bindControl();
      const runnerLayer = yield* Layer.build(
        ToolRunner.layer({
          stackId: saved.id,
          root: `${root}/data`,
          cacheRoot: `${root}/cache`,
          runtime: "docker",
        }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, engine))),
      );
      const runtime = yield* makeRuntime(
        owner,
        {
          endpoint: {
            stackId: saved.id,
            identity: saved.identity,
            pid: process.pid,
            port: acquired.port,
            release: "test",
          },
          secret: "test-secret",
        },
        acquired.server,
        acquired.closeConnections,
      ).pipe(
        Effect.provideService(ToolRunner.Service, Context.get(runnerLayer, ToolRunner.Service)),
      );
      yield* runtime.serve;
      const failure = yield* shutdownOwner(runtime.access, true).pipe(Effect.flip);
      expect(listCalls, failure.message).toBe(3);
      expect(yield* (yield* stateFor(`${root}/state`)).read(saved.id)).toBeDefined();
      yield* Deferred.await(runtime.exit).pipe(Effect.timeout("10 seconds"));
      const retryOwner = yield* Layer.build(ownerLayer).pipe(
        Effect.map((context) => Context.get(context, Owner.Service)),
      );
      yield* retryOwner.namespace.destroy;
      expect(listCalls).toBe(5);
      expect(yield* (yield* stateFor(`${root}/state`)).read(saved.id)).toBeUndefined();
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
