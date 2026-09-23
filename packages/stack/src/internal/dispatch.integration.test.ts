import { NodeServices } from "@effect/platform-node";
import { Context, Data, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { expect, it } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { HostEndpoint } from "../HostProcess.ts";
import * as State from "../State.ts";

const fixturePath = fileURLToPath(
  new URL("../../tests/compiled-dispatch-fixture.ts", import.meta.url),
);
class FixtureError extends Data.TaggedError("FixtureError")<{ readonly message: string }> {}

const spawnFixture = Effect.fnUntraced(function* (executable: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.spawn(
    ChildProcess.make(executable, args, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      forceKillAfter: "2 seconds",
    }),
  );
});

const readOutput = (child: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.all(
    [
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
      child.stderr.pipe(Stream.decodeText, Stream.mkString),
      child.exitCode,
    ],
    { concurrency: 3 },
  );

const compileFixture = (executable: string) =>
  Effect.gen(function* () {
    const child = yield* spawnFixture("bun", [
      "build",
      fixturePath,
      "--compile",
      `--outfile=${executable}`,
    ]);
    const [, stderr, exitCode] = yield* readOutput(child);
    if (Number(exitCode) !== 0)
      return yield* new FixtureError({ message: `Fixture build failed: ${stderr}` });
  });

it.live("dispatches compiled owner and native launchers through the production boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-compiled-dispatch-" });
      const executable = path.join(root, "dispatch-fixture");
      yield* compileFixture(executable);
      const stateRoot = path.join(root, "state");
      const cacheRoot = path.join(root, "cache");
      const stateContext = yield* Layer.build(State.layer({ root: stateRoot }));
      const state = Context.get(stateContext, State.Service);
      const stackId = "compiled-dispatch";
      yield* state.save({
        id: stackId,
        runtime: "native",
        identity: { projectRoot: root, branchContext: "main", stackName: "compiled" },
        instances: [],
        composition: { members: [], dependencies: [] },
        ports: [],
      });

      const runOwner = (mode: "owner" | "stop") =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawnFixture(executable, [mode, stateRoot, cacheRoot, stackId]);
            const [stdout, stderr, exitCode] = yield* readOutput(child);
            return {
              endpoint: yield* Schema.decodeEffect(Schema.fromJsonString(HostEndpoint))(
                stdout.trim(),
              ),
              stderr,
              exitCode,
            };
          }),
        );
      yield* Effect.addFinalizer(() => runOwner("stop").pipe(Effect.ignore));
      const first = yield* runOwner("owner");
      expect(first.exitCode, first.stderr).toBe(0);
      const reopened = yield* runOwner("owner");
      expect(reopened.exitCode, reopened.stderr).toBe(0);
      expect(reopened.endpoint).toEqual(first.endpoint);
      const stopped = yield* runOwner("stop");
      expect(stopped.exitCode, stopped.stderr).toBe(0);

      const missing = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawnFixture(executable, ["owner", stateRoot, cacheRoot, "missing"]);
          return yield* readOutput(child);
        }),
      );
      expect(missing[2]).toBe(1);
      expect(missing[1]).toContain("Stack is not registered");

      const pidMarker = path.join(root, "native-pid");
      const native = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawnFixture(executable, ["native", pidMarker]);
          return yield* readOutput(child);
        }),
      );
      expect(native[2], native[1]).toBe(0);
      expect(native[0]).toContain("native-ready\nnative-stopped\n");
      const workloadPid = Number(yield* fs.readFileString(pidMarker));
      expect(() => process.kill(workloadPid, 0)).toThrow();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
