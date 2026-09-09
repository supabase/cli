import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Ref,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import { StackStateInvalidError } from "../public/Errors.ts";
import { withRegistryLock } from "./StackStateStore.ts";

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("cross-process registry lease", () => {
  it.live("blocks a competing action, then recovers after an exact child kill", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-registry-lease-" });
        const enteredPath = path.join(root, "child-entered");
        const competingPath = path.join(root, "competing-entered");
        const moduleUrl = new URL("./StackStateStore.ts", import.meta.url).href;
        const script = `
          const { Effect, FileSystem } = await import("effect");
          const { NodeServices } = await import("@effect/platform-node");
          const { withRegistryLock } = await import(process.env.REGISTRY_MODULE);
          await Effect.runPromise(withRegistryLock(process.env.REGISTRY_ROOT, Effect.gen(function* () {
            const filesystem = yield* FileSystem.FileSystem;
            yield* filesystem.writeFileString(process.env.ENTERED_PATH, "child");
            process.stdout.write("READY\\n");
            yield* Effect.never;
          })).pipe(Effect.provide(NodeServices.layer)));
        `;
        const child = yield* ChildProcess.make(
          process.execPath,
          ["--input-type=module", "-e", script],
          {
            cwd: process.cwd(),
            env: { REGISTRY_MODULE: moduleUrl, REGISTRY_ROOT: root, ENTERED_PATH: enteredPath },
            extendEnv: true,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const ready = yield* Deferred.make<void>();
        const stderrText = yield* Ref.make<ReadonlyArray<string>>([]);
        const childExitCode = yield* Ref.make<Option.Option<number>>(Option.none());
        const childOutput = yield* child.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) =>
            line === "READY" ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid) : Effect.void,
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        const childErrors = yield* child.stderr.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) => Ref.update(stderrText, (lines) => [...lines, line])),
          Effect.forkChild({ startImmediately: true }),
        );
        const exitWatcher = yield* child.exitCode.pipe(
          Effect.flatMap((code) => Ref.set(childExitCode, Option.some(code))),
          Effect.forkChild({ startImmediately: true }),
        );
        try {
          yield* Deferred.await(ready).pipe(
            Effect.timeoutOrElse({
              duration: "15 seconds",
              orElse: () =>
                Effect.gen(function* () {
                  const errors = yield* Ref.get(stderrText);
                  const exitCode = yield* Ref.get(childExitCode);
                  const status = Option.isSome(exitCode)
                    ? ` (exit code ${String(exitCode.value)})`
                    : "";
                  return yield* new StackStateInvalidError({
                    message: `registry child did not become ready${status}${errors.length === 0 ? "" : `: ${errors.join("\\n")}`}`,
                  });
                }),
            }),
          );
          expect(yield* fs.exists(enteredPath)).toBe(true);
          const competing = yield* withRegistryLock(
            root,
            fs.writeFileString(competingPath, "competing"),
          ).pipe(Effect.exit);
          expect(Exit.isFailure(competing)).toBe(true);
          const contentionError = errorOf(competing);
          expect(contentionError).toBeInstanceOf(StackStateInvalidError);
          expect(contentionError?.message).toBe("Stack registry is busy");
          expect(yield* fs.exists(competingPath)).toBe(false);
          yield* child.kill({ killSignal: "SIGKILL" });
          yield* child.exitCode.pipe(Effect.ignore);
          const recovered = yield* withRegistryLock(root, Effect.succeed("recovered"));
          expect(recovered).toBe("recovered");
        } finally {
          yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
          yield* child.exitCode.pipe(Effect.ignore);
          yield* Fiber.interrupt(childOutput);
          yield* Fiber.interrupt(childErrors);
          yield* Fiber.interrupt(exitWatcher);
        }
      }),
    ),
  );
});
