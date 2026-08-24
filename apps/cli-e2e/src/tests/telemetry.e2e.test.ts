import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect } from "vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { testBehaviour } from "./test-context.ts";

const testLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const JsonValue = Schema.fromJsonString(Schema.Unknown);

describe("telemetry", () => {
  describe("telemetry:enable", () => {
    testBehaviour("enables telemetry", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["telemetry", "enable"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Telemetry is enabled.");
        }),
      ),
    );

    testBehaviour("exits non-zero on unwritable config dir", ({ run, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.chmod(workspace.path, 0o555);
          const result = yield* Effect.promise(() => run(["telemetry", "enable"])).pipe(
            Effect.ensuring(fs.chmod(workspace.path, 0o755).pipe(Effect.orDie)),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });

  describe("telemetry:disable", () => {
    testBehaviour("disables telemetry", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["telemetry", "disable"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Telemetry is disabled.");
        }),
      ),
    );
  });

  describe("telemetry:status", () => {
    testBehaviour("shows current telemetry state", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["telemetry", "status"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toMatch(/Telemetry is (enabled|disabled)\./);
        }),
      ),
    );

    testBehaviour("round-trip: enable then status shows enabled", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() => run(["telemetry", "enable"]));
          const result = yield* Effect.promise(() => run(["telemetry", "status"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Telemetry is enabled.");
        }),
      ),
    );

    testBehaviour("round-trip: disable then status shows disabled", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() => run(["telemetry", "disable"]));
          const result = yield* Effect.promise(() => run(["telemetry", "status"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Telemetry is disabled.");
        }),
      ),
    );

    testBehaviour("handles corrupted config gracefully", ({ run, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const telemetryPath = path.join(workspace.path, "telemetry.json");
          yield* fs.writeFileString(telemetryPath, "{{not valid json}}");
          const result = yield* Effect.promise(() => run(["telemetry", "status"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Telemetry is enabled.");
          const content = yield* fs.readFileString(telemetryPath);
          yield* Schema.decodeEffect(JsonValue)(content);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });
});
