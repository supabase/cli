import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { watch } from "node:fs"; // oxlint-disable-line effecttsgo/node-builtin-import -- synchronous watcher subscription must precede child spawn.
import { fileURLToPath } from "node:url";

const config = fileURLToPath(new URL("../tests/effect-timeout.vitest.config.ts", import.meta.url));

it.live("awaits an Effect finalizer after a timed out child test", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "effect-timeout-" });
      const marker = `${root}/cleanup`;
      const started = `${marker}.started`;
      const startedSignal = yield* Deferred.make<void>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() => watch(root)),
        (watcher) =>
          Effect.gen(function* () {
            watcher.on("change", (_event, filename) => {
              if (filename !== path.basename(started)) return;
              Deferred.doneUnsafe(startedSignal, Effect.void);
            });
            const child = yield* spawner.spawn(
              ChildProcess.make(process.execPath, ["--bun", "vitest", "run", "--config", config], {
                cwd: fileURLToPath(new URL("..", import.meta.url)),
                env: { ...process.env, SUPABASE_TIMEOUT_MARKER: marker },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              }),
            );
            const stdout = yield* child.stdout.pipe(
              Stream.decodeText,
              Stream.mkString,
              Effect.forkScoped,
            );
            const stderr = yield* child.stderr.pipe(
              Stream.decodeText,
              Stream.mkString,
              Effect.forkScoped,
            );
            const readiness = yield* Deferred.await(startedSignal).pipe(
              Effect.as({ _tag: "started" as const }),
              Effect.raceFirst(
                child.exitCode.pipe(Effect.map((code) => ({ _tag: "exited" as const, code }))),
              ),
            );
            if (readiness._tag === "exited") {
              const output = `${yield* Fiber.join(stdout)}\n${yield* Fiber.join(stderr)}`;
              return yield* Effect.die(
                new Error(`child exited before finalizer handshake:\n${output}`),
              );
            }
            yield* fs.writeFileString(`${marker}.release`, "release");
            const code = yield* child.exitCode;
            return {
              code,
              output: `${yield* Fiber.join(stdout)}\n${yield* Fiber.join(stderr)}`,
            };
          }),
        (watcher) => Effect.sync(() => watcher.close()),
      );
      expect(Number(result.code), result.output).not.toBe(0);
      expect(result.output).toContain("Test timed out in 100ms");
      expect(yield* fs.readFileString(marker)).toBe("released");
      expect(yield* fs.readFileString(`${marker}.after-all`)).toBe("released-present");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("retains cleanup defect diagnostics after timeout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "effect-timeout-defect-" });
      const marker = `${root}/cleanup-defect`;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["--bun", "vitest", "run", "--config", config], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { ...process.env, SUPABASE_TIMEOUT_DEFECT_MARKER: marker },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const stdout = yield* child.stdout.pipe(
        Stream.decodeText,
        Stream.mkString,
        Effect.forkScoped,
      );
      const stderr = yield* child.stderr.pipe(
        Stream.decodeText,
        Stream.mkString,
        Effect.forkScoped,
      );
      const code = yield* child.exitCode;
      const output = `${yield* Fiber.join(stdout)}\n${yield* Fiber.join(stderr)}`;
      expect(Number(code), output).not.toBe(0);
      expect(output).toContain("Test timed out in 100ms");
      expect(output).toContain("cleanup-defect");
      expect(output).not.toContain("Hook timed out");
      expect(yield* fs.readFileString(marker)).toBe("cleanup-defect-sentinel");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("retains body and cleanup diagnostics together", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["--bun", "vitest", "run", "--config", config], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { ...process.env, SUPABASE_TIMEOUT_DOUBLE_FAILURE: "1" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const stdout = yield* child.stdout.pipe(
        Stream.decodeText,
        Stream.mkString,
        Effect.forkScoped,
      );
      const stderr = yield* child.stderr.pipe(
        Stream.decodeText,
        Stream.mkString,
        Effect.forkScoped,
      );
      const code = yield* child.exitCode;
      const output = `${yield* Fiber.join(stdout)}\n${yield* Fiber.join(stderr)}`;
      expect(Number(code), output).not.toBe(0);
      expect(output).toContain("body-defect");
      expect(output).toContain("cleanup-defect");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("retains the formatted diagnostic for a single defect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["--bun", "vitest", "run", "--config", config], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { ...process.env, SUPABASE_TIMEOUT_SINGLE_DEFECT: "1" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const stdout = yield* child.stdout.pipe(
        Stream.decodeText,
        Stream.mkString,
        Effect.forkScoped,
      );
      const stderr = yield* child.stderr.pipe(
        Stream.decodeText,
        Stream.mkString,
        Effect.forkScoped,
      );
      const code = yield* child.exitCode;
      const output = `${yield* Fiber.join(stdout)}\n${yield* Fiber.join(stderr)}`;
      expect(Number(code), output).not.toBe(0);
      expect(output).toContain("single-defect");
      expect(output).toMatch(/^\s*Error: single-defect$/m);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
