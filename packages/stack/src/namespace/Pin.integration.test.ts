import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { pin } from "./Pin.ts";

/** Reports whether a separate process can take an EXCLUSIVE lock on `lockPath` right now. */
const exclusiveLockOutcome = (lockPath: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const script = `
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(process.argv[1]);
        database.exec("PRAGMA busy_timeout = 0");
        try {
          database.exec("BEGIN EXCLUSIVE");
          console.log("acquired");
        } catch (error) {
          if (error.errcode !== 5) {
            console.error(error);
            process.exit(1);
          }
          console.log("busy");
        }
      `;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["-e", script, lockPath], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText, Stream.mkString),
          child.stderr.pipe(Stream.decodeText, Stream.mkString),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      expect(Number(exitCode), stderr).toBe(0);
      return stdout.trim();
    }),
  );

describe("pins", () => {
  it.live(
    "another process stays excluded after a second in-process pin on the same file is released",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-pin-" });
          const lockPath = `${directory}/generation.lock`;

          const holderScope = yield* Scope.make();
          yield* pin(lockPath).pipe(Scope.provide(holderScope));
          const competitorScope = yield* Scope.make();
          yield* pin(lockPath).pipe(Scope.provide(competitorScope));
          yield* Scope.close(competitorScope, Exit.void);

          expect(yield* exclusiveLockOutcome(lockPath)).toBe("busy");

          yield* Scope.close(holderScope, Exit.void);
          expect(yield* exclusiveLockOutcome(lockPath)).toBe("acquired");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    20_000,
  );
});
