import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Path, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach } from "vitest";

import { LegacyLocalDbRunningError, legacyIsLocalDbRunning } from "./local-db-running.ts";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "supabase-legacy-local-db-running-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/**
 * A spawner whose child's stderr NEVER reaches EOF: it emits `stderr` once and
 * then stays open, the way Windows `docker.exe` behaves when a helper process
 * keeps the inherited stderr handle alive past the CLI's own exit
 * (supabase/cli#6110). The exit code itself resolves immediately.
 */
function heldPipeSpawner(result: { exitCode: number; stderr?: string }) {
  const encoder = new TextEncoder();
  const spawned: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      spawned.push(command._tag === "StandardCommand" ? command.args : []);
      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode));
      const stderrHead =
        result.stderr !== undefined ? Stream.make(encoder.encode(result.stderr)) : Stream.empty;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.empty,
        stderr: Stream.concat(stderrHead, Stream.never),
        all: Stream.empty,
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, spawned };
}

const run = <A, E>(effect: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* effect(fs, path);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyIsLocalDbRunning", () => {
  it.live(
    "reports not-running from the exit code even when stderr never reaches EOF",
    () => {
      const { spawner } = heldPipeSpawner({
        exitCode: 1,
        stderr: "Error: No such container: supabase_db_proj\n",
      });
      return run((fs, path) =>
        legacyIsLocalDbRunning(spawner, fs, path, workdir, "proj").pipe(
          Effect.map((running) => {
            expect(running).toBe(false);
          }),
        ),
      );
    },
    10_000,
  );

  it.live("reports running immediately on a zero exit even when stderr never reaches EOF", () => {
    const { spawner } = heldPipeSpawner({ exitCode: 0 });
    const startedAt = performance.now();
    return run((fs, path) =>
      legacyIsLocalDbRunning(spawner, fs, path, workdir, "proj").pipe(
        Effect.map((running) => {
          expect(running).toBe(true);
          // The running fast path must not pay the post-exit stderr grace —
          // reordering the grace above the exit-0 return would fail this.
          expect(performance.now() - startedAt).toBeLessThan(500);
        }),
      ),
    );
  });

  it.live(
    "still classifies a daemon-unreachable failure from collected stderr without waiting for EOF",
    () => {
      const { spawner } = heldPipeSpawner({
        exitCode: 1,
        stderr:
          'error during connect: Get "http://docker/v1.51/containers/supabase_db_proj/json": open //./pipe/docker_engine: The system cannot find the file specified.\n',
      });
      return run((fs, path) =>
        legacyIsLocalDbRunning(spawner, fs, path, workdir, "proj").pipe(
          Effect.flip,
          Effect.map((error) => {
            expect(error).toBeInstanceOf(LegacyLocalDbRunningError);
            expect(error.message).toContain("failed to inspect service");
            expect(error.suggestion).toBeDefined();
          }),
        ),
      );
    },
    10_000,
  );
});
