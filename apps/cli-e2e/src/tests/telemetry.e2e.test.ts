import { Effect, FileSystem, Path } from "effect";
import { describe, expect } from "vitest";
import { runE2e, testBehaviour } from "./test-context.ts";

describe("telemetry", () => {
  describe("telemetry:enable", () => {
    testBehaviour("enables telemetry", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["telemetry", "enable"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Telemetry is enabled.");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on unwritable config dir", ({ run, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* Effect.acquireUseRelease(
            fs.chmod(workspace.path, 0o555),
            () =>
              Effect.gen(function* () {
                const result = yield* run(["telemetry", "enable"]);
                expect(result.exitCode).not.toBe(0);
              }),
            () => fs.chmod(workspace.path, 0o755),
          );
        }),
        signal,
      ),
    );
  });

  describe("telemetry:disable", () => {
    testBehaviour("disables telemetry", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["telemetry", "disable"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Telemetry is disabled.");
        }),
        signal,
      ),
    );
  });

  describe("telemetry:status", () => {
    testBehaviour("shows current telemetry state", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["telemetry", "status"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toMatch(/Telemetry is (enabled|disabled)\./);
        }),
        signal,
      ),
    );

    testBehaviour("round-trip: enable then status shows enabled", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* run(["telemetry", "enable"]);
          const result = yield* run(["telemetry", "status"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Telemetry is enabled.");
        }),
        signal,
      ),
    );

    testBehaviour("round-trip: disable then status shows disabled", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* run(["telemetry", "disable"]);
          const result = yield* run(["telemetry", "status"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Telemetry is disabled.");
        }),
        signal,
      ),
    );

    testBehaviour("handles corrupted config gracefully", ({ run, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const telemetryPath = path.join(workspace.path, "telemetry.json");
          yield* fs.writeFileString(telemetryPath, "{{not valid json}}");
          const result = yield* run(["telemetry", "status"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Telemetry is enabled.");
          const telemetry = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
            yield* fs.readFile(telemetryPath),
          );
          expect(() => JSON.parse(telemetry)).not.toThrow();
        }),
        signal,
      ),
    );
  });
});
