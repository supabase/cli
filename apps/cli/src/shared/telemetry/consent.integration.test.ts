import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Path,
  PlatformError,
  Ref,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { writeTelemetryConfig } from "./consent.ts";
import type { TelemetryConfig } from "./types.ts";

const config: TelemetryConfig = {
  consent: "granted",
  device_id: "test-device",
  session_id: "test-session",
  session_last_active: 1,
};

const tempRoot = useTempWorkdir("supabase-consent-publish-");

const seedPreviousConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = tempRoot.current;
  const configPath = path.join(dir, "telemetry.json");
  yield* fs.writeFileString(configPath, "previous config");
  return { dir, configPath };
});

const temporaryFiles = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.readDirectory(dir)).filter((name) => name.includes(".tmp."));
  });

function injectedFailure(pathOrDescriptor: string, code: string, cause?: unknown) {
  return PlatformError.systemError({
    _tag: code === "EACCES" ? "PermissionDenied" : code === "EBUSY" ? "Busy" : "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor,
    description: "injected replacement failure",
    cause: cause ?? Object.assign(new Error("sharing violation"), { code }),
  });
}

describe("writeTelemetryConfig", () => {
  it.effect("retries Windows replacement failures, then publishes the config", () =>
    Effect.gen(function* () {
      const { dir, configPath } = yield* seedPreviousConfig;
      const fs = yield* FileSystem.FileSystem;
      const calls = yield* Ref.make(0);
      const remainingFailures = yield* Ref.make(2);
      const temporaryPaths = yield* Ref.make<ReadonlyArray<string>>([]);
      const firstFailure = yield* Deferred.make<void>();
      const publishing = yield* writeTelemetryConfig(config, dir, "win32").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              const call = yield* Ref.updateAndGet(calls, (value) => value + 1);
              const remaining = yield* Ref.get(remainingFailures);
              if (remaining > 0) {
                yield* Ref.set(remainingFailures, remaining - 1);
                yield* Ref.update(temporaryPaths, (paths) => [...paths, from]);
                yield* Deferred.succeed(firstFailure, undefined);
                return yield* injectedFailure(to, call === 1 ? "EPERM" : "EACCES");
              }
              return yield* fs.rename(from, to);
            }),
          remove: (filePath, options) =>
            filePath.includes(".tmp.")
              ? Effect.fail(injectedFailure(filePath, "EACCES"))
              : fs.remove(filePath, options),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(firstFailure);
      yield* TestClock.adjust("30 millis");
      yield* Fiber.join(publishing);
      expect(yield* Ref.get(calls)).toBe(3);
      const retries = yield* Ref.get(temporaryPaths);
      expect(retries).toHaveLength(2);
      expect(retries[0]).toContain(".tmp.");
      expect(retries[1]).toBe(retries[0]);
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* fs.readFileString(configPath),
        ),
      ).toEqual(config);
      expect(yield* temporaryFiles(dir)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("cleans the temporary file when cancelled during replacement backoff", () =>
    Effect.gen(function* () {
      const { dir, configPath } = yield* seedPreviousConfig;
      const fs = yield* FileSystem.FileSystem;
      const firstFailure = yield* Deferred.make<void>();
      const publishing = yield* writeTelemetryConfig(config, dir, "win32").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            Deferred.succeed(firstFailure, undefined).pipe(
              Effect.andThen(Effect.fail(injectedFailure(to, "EBUSY"))),
            ),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(firstFailure);
      yield* Fiber.interrupt(publishing);
      expect(yield* fs.readFileString(configPath)).toBe("previous config");
      expect(yield* temporaryFiles(dir)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("preserves the normalized platform error when retries exhaust", () =>
    Effect.gen(function* () {
      const { dir, configPath } = yield* seedPreviousConfig;
      const fs = yield* FileSystem.FileSystem;
      const calls = yield* Ref.make(0);
      const firstFailure = yield* Deferred.make<void>();
      const originalCause = Object.assign(new Error("sharing violation"), {
        code: "EACCES",
      });
      const publishing = yield* writeTelemetryConfig(config, dir, "win32").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (_from, to) =>
            Ref.updateAndGet(calls, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(firstFailure, undefined)),
              Effect.andThen(Effect.fail(injectedFailure(to, "EACCES", originalCause))),
            ),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(firstFailure);
      yield* TestClock.adjust("950 millis");
      const result = yield* Fiber.await(publishing);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain("EACCES");
        expect(Cause.pretty(result.cause)).toContain(configPath);
        const defect = Cause.findDefect(result.cause);
        expect(Result.isSuccess(defect)).toBe(true);
        if (Result.isSuccess(defect)) {
          expect(defect.success).toBeInstanceOf(PlatformError.PlatformError);
          const platformError = defect.success;
          if (platformError instanceof PlatformError.PlatformError) {
            expect(platformError.reason.description).toContain("injected replacement failure");
            expect(platformError.reason.description).toContain("EACCES");
            expect(platformError.reason.description).not.toContain("FileSystem.rename");
          }
          expect(
            platformError instanceof PlatformError.PlatformError &&
              platformError.reason._tag === "PermissionDenied" &&
              platformError.cause instanceof PlatformError.PlatformError &&
              platformError.cause.cause === originalCause,
          ).toBe(true);
        }
      }
      expect(yield* Ref.get(calls)).toBe(13);
      expect(yield* fs.readFileString(configPath)).toBe("previous config");
      expect(yield* temporaryFiles(dir)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("does not retry unrelated errors or failures on another platform", () =>
    Effect.gen(function* () {
      const { dir, configPath } = yield* seedPreviousConfig;
      const fs = yield* FileSystem.FileSystem;
      for (const [platform, code] of [
        ["win32", "EINVAL"],
        ["darwin", "EPERM"],
      ] as const) {
        const calls = yield* Ref.make(0);
        const result = yield* writeTelemetryConfig(config, dir, platform).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: (_from, to) =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.andThen(Effect.fail(injectedFailure(to, code))),
              ),
          }),
          Effect.exit,
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* Ref.get(calls)).toBe(1);
        expect(yield* fs.readFileString(configPath)).toBe("previous config");
        expect(yield* temporaryFiles(dir)).toEqual([]);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("removes a partially written temporary file when writing fails", () =>
    Effect.gen(function* () {
      const { dir, configPath } = yield* seedPreviousConfig;
      const fs = yield* FileSystem.FileSystem;
      const result = yield* writeTelemetryConfig(config, dir).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (filePath, _content, options) =>
            filePath.includes(".tmp.")
              ? fs
                  .writeFileString(filePath, "partial", options)
                  .pipe(Effect.andThen(Effect.fail(injectedFailure(filePath, "EACCES"))))
              : fs.writeFileString(filePath, _content, options),
        }),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* fs.readFileString(configPath)).toBe("previous config");
      expect(yield* temporaryFiles(dir)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
