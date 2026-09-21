import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Data,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import * as State from "./State.ts";

class FixtureError extends Data.TaggedError("StateLockFixtureError")<{
  readonly message: string;
}> {}
const fixture = fileURLToPath(new URL("../tests/state-lock-fixture.ts", import.meta.url));
const readOutput = (child: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.all(
    [
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
      child.stderr.pipe(Stream.decodeText, Stream.mkString),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );

for (const compiled of [false, true]) {
  it.live(
    `serializes writers and releases a killed holder while its child survives (${compiled ? "compiled" : "source"})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-lock-process-" });
          const executable = compiled
            ? `${root}/fixture${process.platform === "win32" ? ".exe" : ""}`
            : process.execPath;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawn = (command: string, args: ReadonlyArray<string>) =>
            spawner.spawn(
              ChildProcess.make(command, args, {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                detached: true,
                forceKillAfter: "1 second",
              }),
            );
          if (compiled) {
            const build = yield* spawn("bun", [
              "build",
              fixture,
              "--compile",
              `--outfile=${executable}`,
            ]);
            const [, stderr, code] = yield* readOutput(build);
            expect(code, stderr).toBe(0);
          }
          const stateRoot = `${root}/state`;
          const context = yield* Layer.build(State.layer({ root: stateRoot }));
          const state = Context.get(context, State.Service);
          const saved: State.SavedStack = {
            id: "stack-main",
            identity: { projectRoot: root, branchContext: "test", stackName: "lock" },
            runtime: "native",
            instances: [],
            composition: { members: [], dependencies: [] },
            ports: [],
          };
          yield* state.save(saved);
          const args = (mode: string, id?: string) => [
            ...(compiled ? [] : [fixture]),
            mode,
            stateRoot,
            ...(id === undefined ? [] : [id]),
          ];
          yield* Effect.forEach(
            ["first", "second", "third"],
            (id) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const writer = yield* spawn(executable, args("write", id));
                  const [, stderr, code] = yield* readOutput(writer);
                  expect(code, stderr).toBe(0);
                }),
              ),
            { concurrency: "unbounded" },
          );
          expect((yield* state.read(saved.id))?.instances.map(({ id }) => id).sort()).toEqual([
            "first",
            "second",
            "third",
          ]);

          const holder = yield* spawn(executable, args("hold"));
          const lines = yield* Queue.unbounded<string>();
          const output = yield* holder.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.runForEach((line) => Queue.offer(lines, line)),
            Effect.forkScoped,
          );
          const stderr = yield* Ref.make("");
          const diagnostics = yield* holder.stderr.pipe(
            Stream.decodeText,
            Stream.runForEach((chunk) => Ref.update(stderr, (text) => text + chunk)),
            Effect.forkScoped,
          );
          const ready = yield* Effect.all([Queue.take(lines), Queue.take(lines)]).pipe(
            Effect.raceFirst(
              holder.exitCode.pipe(
                Effect.matchEffect({
                  onFailure: (cause) =>
                    Ref.get(stderr).pipe(
                      Effect.flatMap((text) =>
                        Effect.fail(
                          new FixtureError({
                            message: `Holder exited before readiness: ${String(cause)}\n${text}`,
                          }),
                        ),
                      ),
                    ),
                  onSuccess: (code) =>
                    Ref.get(stderr).pipe(
                      Effect.flatMap((text) =>
                        Effect.fail(
                          new FixtureError({
                            message: `Holder exited before readiness (${code}): ${text}`,
                          }),
                        ),
                      ),
                    ),
                }),
              ),
            ),
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () =>
                Ref.get(stderr).pipe(
                  Effect.flatMap((text) =>
                    Effect.fail(
                      new FixtureError({ message: `Holder readiness timed out: ${text}` }),
                    ),
                  ),
                ),
            }),
          );
          expect(ready).toContain("locked");
          const childLine = ready.find((line) => line.startsWith("child:"));
          if (childLine === undefined)
            return yield* new FixtureError({ message: "Child readiness missing" });
          const childPid = yield* Schema.decodeEffect(Schema.FiniteFromString)(childLine.slice(6));
          const kill = (pid: number) =>
            Effect.try({
              try: () => process.kill(pid, "SIGKILL"),
              catch: (cause) => new FixtureError({ message: String(cause) }),
            });
          yield* Effect.addFinalizer(() =>
            kill(childPid).pipe(
              Effect.ignore,
              Effect.andThen(Fiber.join(output)),
              Effect.andThen(Fiber.join(diagnostics)),
              Effect.timeout("5 seconds"),
              Effect.orDie,
            ),
          );
          yield* kill(Number(holder.pid));
          yield* holder.exitCode.pipe(Effect.exit);
          yield* state.withLock(
            state.save({ ...saved, identity: { ...saved.identity, stackName: "after-crash" } }),
          );
          expect((yield* state.read(saved.id))?.identity.stackName).toBe("after-crash");
          yield* Effect.try({
            try: () => process.kill(childPid, 0),
            catch: (cause) =>
              new FixtureError({ message: `Child did not survive holder: ${String(cause)}` }),
          });
          expect((yield* fs.stat(`${stateRoot}/.registry-lock.sqlite`)).size).toBe(0n);
          expect((yield* fs.readDirectory(stateRoot)).sort()).toEqual([
            ".registry-lock.sqlite",
            saved.id,
          ]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}
