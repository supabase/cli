import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect } from "vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { testBehaviour } from "./test-context.ts";

const MIGRATION_NAME = "my_change";
const testLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

describe("migrations", () => {
  describe("migration:new", () => {
    testBehaviour("creates timestamped sql file", ({ run, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["migration", "new", MIGRATION_NAME]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Created new migration at");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const files = yield* fs.readDirectory(
            path.join(workspace.path, "supabase", "migrations"),
          );
          expect(files.some((f) => f.endsWith(`_${MIGRATION_NAME}.sql`))).toBe(true);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero without name argument", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["migration", "new"]));
          expect(result.exitCode).not.toBe(0);
          // CLI-1901: a missing positional argument's usage block now prints to
          // stderr (never stdout) instead of being duplicated across both.
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("migration name");
        }),
      ),
    );
  });

  describe("migration:list", () => {
    testBehaviour("exits non-zero on connection refused", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["migration", "list", "--local"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
      ),
    );
  });

  describe("migration:up", () => {
    testBehaviour("exits non-zero on connection refused", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["migration", "up", "--local"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
      ),
    );
  });

  describe("migration:down", () => {
    testBehaviour("exits non-zero on connection refused", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["migration", "down", "--local"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
      ),
    );

    testBehaviour("exits non-zero on connection refused with --last 2", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["migration", "down", "--last", "2", "--local"]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
      ),
    );
  });

  describe("migration:repair", () => {
    testBehaviour("exits non-zero when --status flag is missing", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["migration", "repair", "--local", "20230101000000"]),
          );
          expect(result.exitCode).not.toBe(0);
          // CLI-1901: a missing required flag now drops the vendored library's
          // duplicate usage dump entirely (Go's cobra suppresses usage for this
          // case too), leaving only this repo's existing Go-parity error line,
          // which spells the flag name without its `--` prefix.
          expect(result.stderr).toContain('"status" not set');
        }),
      ),
    );

    testBehaviour("exits non-zero on connection refused", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["migration", "repair", "--status", "applied", "--local", "20230101000000"]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
      ),
    );
  });

  describe("migration:squash", () => {
    testBehaviour("exits non-zero on connection refused", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["migration", "squash", "--local"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).not.toBe("");
        }),
      ),
    );
  });

  describe("migration:fetch", () => {
    testBehaviour("exits non-zero on connection refused", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["migration", "fetch", "--local"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to connect");
        }),
      ),
    );
  });
});
