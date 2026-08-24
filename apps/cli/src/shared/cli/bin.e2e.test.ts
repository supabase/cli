import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Path,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as PlatformError from "effect/PlatformError";

const waitForPath = (
  fs: FileSystem.FileSystem,
  directory: string,
  path: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const watcher = yield* fs.watch(directory).pipe(
        Stream.filterEffect(() => fs.exists(path)),
        Stream.runHead,
        Effect.asVoid,
        Effect.forkChild({ startImmediately: true }),
      );
      if (yield* fs.exists(path)) {
        yield* Fiber.interrupt(watcher).pipe(Effect.ignore);
        return;
      }
      yield* Fiber.join(watcher).pipe(Effect.ignore);
    }),
  );

const runShimSignalCase = (mode: "handled" | "terminated") =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const pathEnvironment = yield* Config.string("PATH").pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
        ),
      );
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-shim-signal-" });
      const markerPath = path.join(tempDir, "ready");
      const childPath = path.join(tempDir, "child.js");
      const shimPath = yield* path.fromFileUrl(
        new URL("../../../dist/supabase.js", import.meta.url),
      );
      const encodedMarkerPath = yield* Schema.encodeUnknownEffect(
        Schema.fromJsonString(Schema.String),
      )(markerPath);
      yield* fs.writeFileString(
        childPath,
        [
          "#!/usr/bin/env node",
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${encodedMarkerPath}, 'ready');`,
          mode === "handled" ? "process.on('SIGTERM', () => process.exit(0));" : "",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      yield* fs.chmod(childPath, 0o755);
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [shimPath], {
          env: { PATH: pathEnvironment, SUPABASE_CLI_BINARY_OVERRIDE: childPath },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      yield* waitForPath(fs, tempDir, markerPath);
      yield* child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
      return yield* child.exitCode.pipe(Effect.exit);
    }),
  ).pipe(Effect.provide(BunServices.layer));

describe("CLI shim signal forwarding", () => {
  it.live("uses the child's zero exit when it handles a forwarded signal", () =>
    Effect.gen(function* () {
      const result = yield* runShimSignalCase("handled");
      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isSuccess(result)) expect(result.value).toBe(0);
    }),
  );

  it.live("mirrors the child's signal death", () =>
    Effect.gen(function* () {
      const result = yield* runShimSignalCase("terminated");
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.hasFails(result.cause)).toBe(true);
      }
    }),
  );
});
