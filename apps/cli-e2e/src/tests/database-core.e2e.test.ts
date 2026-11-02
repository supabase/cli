import { Effect, FileSystem, Path, Schema } from "effect";
import { describe, expect } from "vitest";
import { linkProject } from "./link-project.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context.ts";

const TEST_MIGRATION_SQL =
  "CREATE TABLE IF NOT EXISTS e2e_test_table (id bigint generated always as identity primary key);";

/** Create a single migration file in supabase/migrations/ and return the SQL. */
const seedMigration = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const migrationsDir = path.join(dir, "supabase", "migrations");
  yield* fs.makeDirectory(migrationsDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(migrationsDir, "20240101000000_e2e_test.sql"),
    TEST_MIGRATION_SQL,
  );
});

describe("db advisors", () => {
  describe("db advisors:security", () => {
    testBehaviour("returns security advisors", ({ run, projectRef, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* run(["db", "advisors", "--type", "security", "--remote"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout.trim()).toBe("");
          expect(result.stderr).toContain("No issues found");
        }),
        signal,
      ),
    );

    testBehaviour(
      "exits zero when --fail-on error and no error-level advisors found",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* run([
              "db",
              "advisors",
              "--type",
              "security",
              "--fail-on",
              "error",
              "--remote",
            ]);
            expect(result.exitCode).toBe(0);
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on 401", ({ run, projectRef, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run(["db", "advisors", "--type", "security", "--remote"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, projectRef, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run(["db", "advisors", "--type", "security", "--remote"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, projectRef, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 429,
            body: { message: "Too Many Requests" },
          });
          const result = yield* run(["db", "advisors", "--type", "security", "--remote"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, projectRef, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });
          const result = yield* run(["db", "advisors", "--type", "security", "--remote"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("db advisors:performance", () => {
    testBehaviour("returns performance advisors", ({ run, projectRef, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* run(["db", "advisors", "--type", "performance", "--remote"]);
          expect(result.exitCode).toBe(0);
          if (result.stdout.trim()) {
            const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
            expect(Array.isArray(parsed)).toBe(true);
          } else {
            expect(result.stderr).toContain("No issues found");
          }
        }),
        signal,
      ),
    );
  });

  describe("db advisors:all", () => {
    testBehaviour("returns advisors with --type all", ({ run, projectRef, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* run(["db", "advisors", "--type", "all", "--remote"]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );
  });
});

describe("db query", () => {
  describe("db query:remote", () => {
    testBehaviour(
      "returns SELECT 1 result in table format",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* run(["db", "query", "SELECT 1", "--read-only", "--remote"]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("1");
          }),
          signal,
        ),
    );

    testBehaviour("returns JSON with --output json", ({ run, projectRef, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* run([
            "db",
            "query",
            "--output",
            "json",
            "SELECT 1",
            "--read-only",
            "--remote",
          ]);
          expect(result.exitCode).toBe(0);
          const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
          // In agent mode (CLAUDECODE env set) the output is wrapped in {warning, boundary, rows}.
          // In normal mode it's a plain array.
          const rows = Array.isArray(parsed) ? parsed : (parsed as { rows: unknown[] }).rows;
          expect(Array.isArray(rows)).toBe(true);
          expect(rows).toHaveLength(1);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, projectRef, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run(["db", "query", "SELECT 1", "--read-only", "--remote"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, projectRef, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run(["db", "query", "SELECT 1", "--read-only", "--remote"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );
  });
});

describe("db push", () => {
  describe("db push:dry-run", () => {
    testBehaviour(
      "exits non-zero on connection refused with --dry-run",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            yield* seedMigration(workspace.path);
            const result = yield* run(["db", "push", "--dry-run", "--remote"]);
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("connect");
          }),
          signal,
        ),
    );
  });

  describe("db push:local", () => {
    testBehaviour("exits non-zero on connection refused without --remote", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["db", "push"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("connect");
        }),
        signal,
      ),
    );
  });

  describe("db push:remote", () => {
    testBehaviour(
      "exits non-zero on connection refused with --remote",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* run(["db", "push", "--remote"]);
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("connect");
          }),
          signal,
        ),
    );
  });
});

describe("db pull", () => {
  testBehaviour("exits non-zero on connection refused without --remote", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["db", "pull"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("connect");
      }),
      signal,
    ),
  );
});

describe("db lint", () => {
  testBehaviour("exits non-zero on connection refused without --remote", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["db", "lint"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("connect");
      }),
      signal,
    ),
  );
});

describe("db dump", () => {
  testBehaviour("exits non-zero on connection refused without --remote", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["db", "dump"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("connect");
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero when --role-only and --data-only are both set", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["db", "dump", "--role-only", "--data-only"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toLowerCase()).toMatch(/role.only|data.only|mutually exclusive/);
      }),
      signal,
    ),
  );
});

describe("db reset", () => {
  testBehaviour("exits non-zero on connection refused without --remote", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["db", "reset"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toMatch(/connect|not running/i);
      }),
      signal,
    ),
  );
});

describe("test new", () => {
  testBehaviour("creates a pgTAP test file", ({ run, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* run(["test", "new", "my_test"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/my_test/);
        const files = (yield* fs.readDirectory(
          path.join(workspace.path, "supabase", "tests"),
        )).filter((f) => f.endsWith("my_test_test.sql"));
        expect(files.length).toBe(1);
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero when name argument is missing", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["test", "new"]);
        expect(result.exitCode).not.toBe(0);
      }),
      signal,
    ),
  );
});

describe("test db", () => {
  testBehaviour("exits non-zero on connection refused without --remote", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["test", "db"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("connect");
      }),
      signal,
    ),
  );
});
