import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Ref,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as State from "./State.ts";

const saved: State.SavedStack = {
  id: "stack-main",
  identity: { projectRoot: "C:\\project", branchContext: "test", stackName: "windows" },
  runtime: "native",
  instances: [],
  composition: { members: [], dependencies: [] },
  ports: [],
};

class HolderError extends Data.TaggedError("StateWindowsHolderError")<{
  readonly message: string;
}> {}

const sharingHolder = String.raw`
$path = $args[0]
$stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
[Console]::In.ReadLine() | Out-Null
$stream.Dispose()
`;

const testSharingViolation = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-windows-" });
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const target = path.join(root, saved.id, "state.json");
      const failures = yield* Ref.make<ReadonlyArray<string>>([]);
      const armed = yield* Ref.make(false);
      const firstFailure = yield* Deferred.make<string>();
      const holderReleased = yield* Deferred.make<void>();
      const injectedFs = Layer.effect(
        FileSystem.FileSystem,
        Effect.succeed({
          ...fs,
          rename: (from: string, to: string) =>
            fs.rename(from, to).pipe(
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  const code =
                    typeof error.cause === "object" && error.cause !== null && "code" in error.cause
                      ? String(error.cause.code)
                      : "";
                  if (to !== target || !(yield* Ref.get(armed))) return;
                  yield* Ref.update(failures, (previous) => [
                    ...previous,
                    code || "<missing errno>",
                  ]);
                  yield* Deferred.succeed(firstFailure, code || "<missing errno>");
                  yield* Deferred.await(holderReleased);
                }),
              ),
            ),
        }),
      );
      const context = yield* Layer.build(State.layer({ root }).pipe(Layer.provide(injectedFs)));
      const state = Context.get(context, State.Service);
      yield* state.save(saved);
      yield* fs.writeFileString(path.join(root, "hold-state.ps1"), sharingHolder);

      const holder = yield* spawner.spawn(
        ChildProcess.make(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(root, "hold-state.ps1"),
            target,
          ],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe", forceKillAfter: "1 second" },
        ),
      );
      const ready = yield* Deferred.make<void>();
      const output = yield* holder.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          line === "ready" ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid) : Effect.void,
        ),
        Effect.forkScoped,
      );
      const stderr = yield* Ref.make("");
      const diagnostics = yield* holder.stderr.pipe(
        Stream.decodeText,
        Stream.runForEach((chunk) => Ref.update(stderr, (text) => text + chunk)),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Ref.get(stderr).pipe(
              Effect.flatMap((text) =>
                Effect.fail(new HolderError({ message: `Holder did not become ready: ${text}` })),
              ),
            ),
        }),
      );
      yield* Ref.set(armed, true);
      const saving = yield* state
        .save({ ...saved, identity: { ...saved.identity, stackName: "recovered" } })
        .pipe(Effect.forkScoped);
      const rawCode = yield* Deferred.await(firstFailure).pipe(Effect.timeout("10 seconds"));
      expect(["EPERM", "EACCES", "EBUSY"]).toContain(rawCode);
      yield* Stream.make(new TextEncoder().encode("release\n")).pipe(Stream.run(holder.stdin));
      const exitCode = yield* holder.exitCode.pipe(Effect.timeout("10 seconds"));
      const holderError = yield* Ref.get(stderr);
      expect(exitCode, holderError).toBe(0);
      yield* Deferred.succeed(holderReleased, undefined);
      yield* Fiber.join(saving).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new HolderError({ message: "State save did not recover after releasing the handle" }),
            ),
        }),
      );
      expect((yield* state.read(saved.id))?.identity.stackName).toBe("recovered");
      expect(yield* Ref.get(failures).pipe(Effect.map((seen) => seen.length))).toBeGreaterThan(0);
      expect(
        (yield* fs.readDirectory(root)).some((entry) => entry.startsWith(".state-write-")),
      ).toBe(false);
      yield* Fiber.join(output);
      yield* Fiber.join(diagnostics);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.live.skipIf(process.platform !== "win32")(
  "retries a real Windows sharing violation after the open state handle is released",
  () => testSharingViolation(),
  30_000,
);
