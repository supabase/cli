import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect } from "vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { testBehaviour } from "./test-context.ts";

const testLayer = Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer, BunPath.layer);

const parseJsonArray = (input: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(input);

const QueryOutputSchema = Schema.Union([
  Schema.Array(Schema.Unknown),
  Schema.Struct({ rows: Schema.Array(Schema.Unknown) }),
]);

const parseQueryOutput = (input: string) =>
  Schema.decodeEffect(Schema.fromJsonString(QueryOutputSchema))(input);

interface HttpRequestOptions extends Omit<RequestInit, "body"> {
  readonly body?: unknown;
}

function httpRequest(input: string, init: HttpRequestOptions): Promise<Response> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const method = init.method ?? "GET";
      if (!HttpMethod.isHttpMethod(method)) {
        return yield* Effect.die(new Error(`Unsupported HTTP method: ${method}`));
      }
      let request = HttpClientRequest.make(method)(input, {
        headers: init.headers === undefined ? {} : new globalThis.Headers(init.headers),
      });
      if (init.body !== undefined) {
        request = yield* HttpClientRequest.bodyJson(request, init.body);
      }
      const response = yield* HttpClient.execute(request);
      const body = yield* response.arrayBuffer;
      return new Response(body, { status: response.status, headers: { ...response.headers } });
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
  );
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

/** Write .supabase/.temp/project-ref and a stub pooler-url so --linked commands
 *  can pass ParseDatabaseConfig without a real postgres TCP connection.
 *
 *  The Go CLI's PersistentPreRunE calls ParseDatabaseConfig which, for --linked,
 *  tries a TCP probe to db.{ref}.localhost:5432. Nothing listens there in the
 *  test harness. By writing a pooler-url file (which GetPoolerConfig reads), the
 *  CLI takes the pooler path instead. Combined with SUPABASE_DB_PASSWORD (set in
 *  harness.ts), ParseDatabaseConfig succeeds without any network call, so the
 *  command reaches its RunE and makes the Management API call under test. */
const linkProject = (dir: string, ref: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = path.join(dir, "supabase", ".temp");
    yield* fs.makeDirectory(tempDir, { recursive: true });
    yield* fs.writeFileString(path.join(tempDir, "project-ref"), ref);
    yield* fs.writeFileString(
      path.join(tempDir, "pooler-url"),
      `postgresql://postgres.${ref}:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
    );
  });

const TEST_MIGRATION_SQL =
  "CREATE TABLE IF NOT EXISTS e2e_test_table (id bigint generated always as identity primary key);";

/** Create a single migration file in supabase/migrations/ and return the SQL. */
const seedMigration = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = path.join(dir, "supabase", "migrations");
    yield* fs.makeDirectory(migrationsDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(migrationsDir, "20240101000000_e2e_test.sql"),
      TEST_MIGRATION_SQL,
    );
  });

// ---------------------------------------------------------------------------
// db advisors
// ---------------------------------------------------------------------------

describe("db advisors", () => {
  describe("db advisors:security", () => {
    testBehaviour("returns security advisors", ({ run, projectRef, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* Effect.promise(() =>
            run(["db", "advisors", "--linked", "--type", "security"]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout.trim()).toBe("");
          expect(result.stderr).toContain("No issues found");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour(
      "exits zero when --fail-on error and no error-level advisors found",
      ({ run, projectRef, workspace }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* Effect.promise(() =>
              run(["db", "advisors", "--linked", "--type", "security", "--fail-on", "error"]),
            );
            expect(result.exitCode).toBe(0);
          }).pipe(Effect.provide(testLayer), Effect.orDie),
        ),
    );

    testBehaviour("exits non-zero on 401", ({ run, projectRef, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["db", "advisors", "--linked", "--type", "security"]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, projectRef, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 403, body: { message: "Forbidden" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["db", "advisors", "--linked", "--type", "security"]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, projectRef, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 429, body: { message: "Too Many Requests" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["db", "advisors", "--linked", "--type", "security"]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, projectRef, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 500, body: { message: "Internal Server Error" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["db", "advisors", "--linked", "--type", "security"]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });

  describe("db advisors:performance", () => {
    testBehaviour("returns performance advisors", ({ run, projectRef, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* Effect.promise(() =>
            run(["db", "advisors", "--linked", "--type", "performance"]),
          );
          expect(result.exitCode).toBe(0);
          if (result.stdout.trim()) {
            const parsed = yield* parseJsonArray(result.stdout);
            expect(Array.isArray(parsed)).toBe(true);
          } else {
            expect(result.stderr).toContain("No issues found");
          }
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });

  describe("db advisors:all", () => {
    testBehaviour("returns advisors with --type all", ({ run, projectRef, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* Effect.promise(() =>
            run(["db", "advisors", "--linked", "--type", "all"]),
          );
          expect(result.exitCode).toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// db query
// ---------------------------------------------------------------------------

describe("db query", () => {
  describe("db query:linked", () => {
    testBehaviour("returns SELECT 1 result in table format", ({ run, projectRef, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* Effect.promise(() => run(["db", "query", "--linked", "SELECT 1"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("1");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("returns JSON with --output json", ({ run, projectRef, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* Effect.promise(() =>
            run(["db", "query", "--linked", "--output", "json", "SELECT 1"]),
          );
          expect(result.exitCode).toBe(0);
          const parsed = yield* parseQueryOutput(result.stdout);
          // In agent mode (CLAUDECODE env set) the output is wrapped in {warning, boundary, rows}.
          // In normal mode it's a plain array.
          const rows = "rows" in parsed ? parsed.rows : parsed;
          expect(Array.isArray(rows)).toBe(true);
          expect(rows).toHaveLength(1);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, projectRef, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() => run(["db", "query", "--linked", "SELECT 1"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, projectRef, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 403, body: { message: "Forbidden" } },
            }),
          );
          const result = yield* Effect.promise(() => run(["db", "query", "--linked", "SELECT 1"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// db push
// ---------------------------------------------------------------------------

describe("db push", () => {
  describe("db push:dry-run", () => {
    testBehaviour(
      "exits non-zero on connection refused with --dry-run",
      ({ run, projectRef, workspace }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            yield* seedMigration(workspace.path);
            const result = yield* Effect.promise(() => run(["db", "push", "--dry-run"]));
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("connect");
          }).pipe(Effect.provide(testLayer), Effect.orDie),
        ),
    );
  });

  describe("db push:local", () => {
    testBehaviour("exits non-zero on connection refused with --local", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["db", "push", "--local"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("connect");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });

  describe("db push:linked", () => {
    testBehaviour(
      "exits non-zero on connection refused with --linked",
      ({ run, projectRef, workspace }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* linkProject(workspace.path, projectRef);
            const result = yield* Effect.promise(() => run(["db", "push"]));
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("connect");
          }).pipe(Effect.provide(testLayer), Effect.orDie),
        ),
    );
  });
});

// ---------------------------------------------------------------------------
// db pull
// ---------------------------------------------------------------------------

describe("db pull", () => {
  testBehaviour("exits non-zero on connection refused with --local", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["db", "pull", "--local"]));
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("connect");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

// ---------------------------------------------------------------------------
// db lint
// ---------------------------------------------------------------------------

describe("db lint", () => {
  testBehaviour("exits non-zero on connection refused with --local", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["db", "lint", "--local"]));
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("connect");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

// ---------------------------------------------------------------------------
// db dump
// ---------------------------------------------------------------------------

describe("db dump", () => {
  testBehaviour("exits non-zero on connection refused with --local", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["db", "dump", "--local"]));
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("connect");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero when --role-only and --data-only are both set", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          run(["db", "dump", "--local", "--role-only", "--data-only"]),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toLowerCase()).toMatch(/role.only|data.only|mutually exclusive/);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

// ---------------------------------------------------------------------------
// db reset
// ---------------------------------------------------------------------------

describe("db reset", () => {
  testBehaviour("exits non-zero on connection refused with --local", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["db", "reset", "--local"]));
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toMatch(/connect|not running/i);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

// ---------------------------------------------------------------------------
// test new
// ---------------------------------------------------------------------------

describe("test new", () => {
  testBehaviour("creates a pgTAP test file", ({ run, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["test", "new", "my_test"]));
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/my_test/);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files = (yield* fs.readDirectory(
          path.join(workspace.path, "supabase", "tests"),
        )).filter((f) => f.endsWith("my_test_test.sql"));
        expect(files.length).toBe(1);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero when name argument is missing", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["test", "new"]));
        expect(result.exitCode).not.toBe(0);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

// ---------------------------------------------------------------------------
// test db
// ---------------------------------------------------------------------------

describe("test db", () => {
  testBehaviour("exits non-zero on connection refused with --local", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["test", "db", "--local"]));
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("connect");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});
