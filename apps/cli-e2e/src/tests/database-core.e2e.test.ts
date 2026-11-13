import { Effect, FileSystem, Path, Schema } from "effect";
import { describe, expect } from "vitest";
import { linkProject } from "./link-project.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context.ts";

const TEST_MIGRATION_SQL =
  "CREATE TABLE IF NOT EXISTS e2e_test_table (id bigint generated always as identity primary key);";

const USERS_SQL =
  "SELECT id, email, created_at, email_confirmed, last_sign_in_at FROM users ORDER BY created_at LIMIT 3";

const UserRow = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  created_at: Schema.String,
  email_confirmed: Schema.Boolean,
  last_sign_in_at: Schema.NullOr(Schema.String),
});

// Agent mode (e.g. CLAUDECODE set) wraps rows in an untrusted-data envelope.
const UsersOutput = Schema.Union([
  Schema.Array(UserRow),
  Schema.Struct({ rows: Schema.Array(UserRow) }),
]);

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

    testBehaviour(
      "renders a users table with uuids, timestamps, booleans and NULL",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* run(["db", "query", USERS_SQL, "--read-only", "--remote"]);
            expect(result.exitCode).toBe(0);
            for (const header of ["id", "email", "created_at", "email_confirmed"]) {
              expect(result.stdout).toContain(header);
            }
            expect(result.stdout).toContain("3f1c2a9e-5b7d-4e8a-9c21-0d4f6b8a1e37");
            expect(result.stdout).toContain("linus@example.org");
            expect(result.stdout).toContain("2024-01-15T09:30:00.123456+00:00");
            expect(result.stdout).toContain("false");
            expect(result.stdout).toContain("NULL");
          }),
          signal,
        ),
    );

    testBehaviour(
      "returns users rows as a JSON array with --output json",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* run([
              "db",
              "query",
              "--output",
              "json",
              USERS_SQL,
              "--read-only",
              "--remote",
            ]);
            expect(result.exitCode).toBe(0);
            const parsed = yield* decodeJsonOutput(UsersOutput)(result.stdout);
            const rows = "rows" in parsed ? parsed.rows : parsed;
            expect(rows).toHaveLength(3);
            expect(rows[2]).toEqual({
              created_at: "2024-03-21T22:01:09.98+00:00",
              email: "linus@example.org",
              email_confirmed: false,
              id: "d7a90c35-1e4b-48f2-a6d3-9f5c2b81e0a6",
              last_sign_in_at: null,
            });
          }),
          signal,
        ),
    );

    testBehaviour(
      "renders long text values wider than the terminal",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* run([
              "db",
              "query",
              "SELECT slug, title, summary FROM articles ORDER BY published_at DESC LIMIT 2",
              "--read-only",
              "--remote",
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("postgres-row-level-security-in-depth");
            expect(result.stdout).toContain("edge-functions-cold-starts");
            expect(result.stdout).toContain("summary");
          }),
          signal,
        ),
    );

    testBehaviour(
      "succeeds with no output rows for an empty result",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* run([
              "db",
              "query",
              "SELECT id, email FROM users WHERE email = 'nobody@example.com'",
              "--read-only",
              "--remote",
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).not.toContain("nobody@example.com");
          }),
          signal,
        ),
    );

    testBehaviour(
      "renders integer, decimal and bigint columns",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* run([
              "db",
              "query",
              "SELECT 42 AS int_value, 19.99::numeric AS price, -0.5::float8 AS delta, 3000000000::bigint AS big_count",
              "--read-only",
              "--remote",
            ]);
            expect(result.exitCode).toBe(0);
            for (const header of ["int_value", "price", "delta", "big_count"]) {
              expect(result.stdout).toContain(header);
            }
            expect(result.stdout).toContain("42");
            expect(result.stdout).toContain("19.99");
            expect(result.stdout).toContain("-0.5");
          }),
          signal,
        ),
    );

    testBehaviour("renders a JSONB column", ({ run, projectRef, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* run([
            "db",
            "query",
            "SELECT id, preferences FROM profiles ORDER BY id LIMIT 2",
            "--read-only",
            "--remote",
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("preferences");
          expect(result.stdout).toContain("theme:dark");
          expect(result.stdout).toContain("theme:light");
        }),
        signal,
      ),
    );

    testBehaviour("renders a multi-line text value", ({ run, projectRef, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* run([
            "db",
            "query",
            "SELECT id, body FROM notes WHERE id = 7",
            "--read-only",
            "--remote",
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Shopping list:");
          expect(result.stdout).toContain("- sourdough");
        }),
        signal,
      ),
    );

    testBehaviour(
      "returns inserted rows from INSERT RETURNING with --yes",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* run([
              "db",
              "query",
              "INSERT INTO todos (task) VALUES ('Write e2e tests') RETURNING id, task, is_complete, inserted_at",
              "--yes",
              "--remote",
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("128");
            expect(result.stdout).toContain("Write e2e tests");
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
