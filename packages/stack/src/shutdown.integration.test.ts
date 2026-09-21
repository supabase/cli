import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Data, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import * as PromiseStack from "./index.ts";
import { HostEndpoint } from "./HostProcess.ts";
import { StackErrorSchema } from "./Rpc.ts";
import * as State from "./State.ts";
import { open as openEffect } from "./effect.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
class FixtureError extends Data.TaggedError("ShutdownFixtureError")<{ readonly message: string }> {}
const fixturePath = fileURLToPath(new URL("../tests/host-process-fixture.ts", import.meta.url));

const waitForEndpoint = (child: ChildProcessSpawner.ChildProcessHandle) =>
  child.getOutputFd(3).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runHead,
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new FixtureError({ message: "owner fixture readiness timed out" })),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new FixtureError({ message: "owner fixture exited before readiness" })),
        onSome: (line) =>
          Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({ type: Schema.Literal("ready"), endpoint: HostEndpoint }),
            ),
          )(line).pipe(
            Effect.map((ready) => ready.endpoint),
            Effect.mapError((cause) => new FixtureError({ message: String(cause) })),
          ),
      }),
    ),
  );

const withHeldOwner = <A, E, R>(
  root: string,
  run: (options: {
    readonly stateRoot: string;
    readonly cacheRoot: string;
    readonly id: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const stateRoot = `${root}/state`;
    const cacheRoot = `${root}/cache`;
    const id = "shutdown-held";
    const context = yield* Layer.build(State.layer({ root: stateRoot }));
    const state = Context.get(context, State.Service);
    yield* state.save({
      id,
      runtime: "native",
      identity: { projectRoot: root, branchContext: "main", stackName: "shutdown-held" },
      instances: [],
      composition: { members: [], dependencies: [] },
      ports: [],
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.acquireUseRelease(
      spawner.spawn(
        ChildProcess.make(process.execPath, [fixturePath, stateRoot, cacheRoot, id, "rpc-held"], {
          cwd: process.cwd(),
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          additionalFds: {
            fd3: { type: "output" },
            fd4: { type: "input" },
          },
          forceKillAfter: "2 seconds",
        }),
      ),
      (owner) =>
        Effect.gen(function* () {
          const endpoint = yield* waitForEndpoint(owner);
          expect(endpoint.pid).toBe(Number(owner.pid));
          return yield* run({ stateRoot, cacheRoot, id });
        }),
      (owner) =>
        Effect.gen(function* () {
          yield* Stream.run(Stream.succeed(new Uint8Array([1])), owner.getInputFd(4));
          yield* owner.exitCode;
        }),
    );
  });

it.live("Effect stop reports shutdown-exit when the acknowledged owner remains alive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-shutdown-effect-" });
      const error = yield* withHeldOwner(root, ({ stateRoot, cacheRoot, id }) =>
        Effect.gen(function* () {
          const stack = yield* openEffect({
            stateRoot,
            cacheRoot,
            id,
          });
          return yield* Effect.flip(stack.stop);
        }),
      );
      expect(Schema.is(StackErrorSchema)(error)).toBe(true);
      if (!Schema.is(StackErrorSchema)(error))
        return yield* Effect.die("unexpected shutdown error");
      expect(error.operation).toBe("shutdown-exit");
      expect(error.message).toContain("shutdown acknowledgement");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("Promise destroy waits for owner disappearance after the RPC acknowledgement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-shutdown-promise-" });
      const error = yield* withHeldOwner(root, ({ stateRoot, cacheRoot, id }) =>
        Effect.acquireUseRelease(
          Effect.tryPromise(() => PromiseStack.open({ stateRoot, cacheRoot, id })),
          (stack) =>
            Effect.tryPromise(() => stack.destroy()).pipe(
              Effect.flip,
              Effect.map((failure) => failure.cause),
            ),
          (stack) => Effect.tryPromise(() => stack.close()),
        ),
      );
      expect(Schema.is(StackErrorSchema)(error)).toBe(true);
      if (!Schema.is(StackErrorSchema)(error))
        return yield* Effect.die("unexpected shutdown error");
      expect(error).toMatchObject({ operation: "shutdown-exit" });
      expect(error.message).toContain("shutdown acknowledgement");
    }),
  ).pipe(Effect.provide(layer)),
);
