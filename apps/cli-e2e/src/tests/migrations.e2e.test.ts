import { Effect, FileSystem, Path } from "effect";
import { describe, expect } from "vitest";
import { runE2e, testBehaviour } from "./test-context.ts";

const MIGRATION_NAME = "my_change";

describe("migrations", () => {
  describe("migration:new", () => {
    testBehaviour("creates timestamped sql file", ({ run, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const result = yield* run(["migration", "new", MIGRATION_NAME]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Created new migration at");
          const files = yield* fs.readDirectory(
            path.join(workspace.path, "supabase", "migrations"),
          );
          expect(files.some((f) => f.endsWith(`_${MIGRATION_NAME}.sql`))).toBe(true);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero without name argument", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["migration", "new"]);
          expect(result.exitCode).not.toBe(0);
          // A missing positional argument's usage block prints to stderr only.
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("migration name");
        }),
        signal,
      ),
    );
  });

  describe("migration:list", () => {
    testBehaviour("exits non-zero on connection refused", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["migration", "list", "--local"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
        signal,
      ),
    );
  });

  describe("migration:up", () => {
    testBehaviour("exits non-zero on connection refused", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["migration", "up", "--local"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
        signal,
      ),
    );
  });

  describe("migration:down", () => {
    testBehaviour("exits non-zero on connection refused", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["migration", "down", "--local"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on connection refused with --last 2", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["migration", "down", "--last", "2", "--local"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
        signal,
      ),
    );
  });

  describe("migration:repair", () => {
    testBehaviour("exits non-zero when --status flag is missing", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["migration", "repair", "--local", "20230101000000"]);
          expect(result.exitCode).not.toBe(0);
          // A missing required flag's error prints once, without a duplicate
          // usage dump, and spells the flag name without its `--` prefix.
          expect(result.stderr).toContain('"status" not set');
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on connection refused", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "migration",
            "repair",
            "--status",
            "applied",
            "--local",
            "20230101000000",
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
        signal,
      ),
    );
  });

  describe("migration:squash", () => {
    testBehaviour("exits non-zero on connection refused", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["migration", "squash", "--local"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).not.toBe("");
        }),
        signal,
      ),
    );
  });

  describe("migration:fetch", () => {
    testBehaviour("exits non-zero on connection refused", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["migration", "fetch", "--local"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
        signal,
      ),
    );
  });
});
