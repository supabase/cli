import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  PlatformError,
  Ref,
  Result,
} from "effect";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TestClock } from "effect/testing";
import { writeTelemetryConfig } from "./consent.ts";
import type { TelemetryConfig } from "./types.ts";

const config: TelemetryConfig = {
  consent: "granted",
  device_id: "test-device",
  session_id: "test-session",
  session_last_active: 1,
};

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "supabase-consent-publish-"));
}

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
  it.effect("retries Windows replacement failures, then publishes the config", () => {
    const dir = makeDir();
    const configPath = path.join(dir, "telemetry.json");
    writeFileSync(configPath, "previous config");

    return Effect.gen(function* () {
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
                return yield* Effect.fail(injectedFailure(to, call === 1 ? "EPERM" : "EACCES"));
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
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(config);
      expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("cleans the temporary file when cancelled during replacement backoff", () => {
    const dir = makeDir();
    const configPath = path.join(dir, "telemetry.json");
    writeFileSync(configPath, "previous config");

    return Effect.gen(function* () {
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
      expect(readFileSync(configPath, "utf8")).toBe("previous config");
      expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("preserves the normalized platform error when retries exhaust", () => {
    const dir = makeDir();
    const configPath = path.join(dir, "telemetry.json");
    writeFileSync(configPath, "previous config");

    return Effect.gen(function* () {
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
      expect(readFileSync(configPath, "utf8")).toBe("previous config");
      expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("does not retry unrelated errors or failures on another platform", () => {
    const dir = makeDir();
    const configPath = path.join(dir, "telemetry.json");
    writeFileSync(configPath, "previous config");

    return Effect.gen(function* () {
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
        expect(readFileSync(configPath, "utf8")).toBe("previous config");
        expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
      }
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("removes a partially written temporary file when writing fails", () => {
    const dir = makeDir();
    const configPath = path.join(dir, "telemetry.json");
    writeFileSync(configPath, "previous config");

    return Effect.gen(function* () {
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
      expect(readFileSync(configPath, "utf8")).toBe("previous config");
      expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });
});
