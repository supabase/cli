import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect } from "vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { testBehaviour } from "./test-context.ts";

const testLayer = Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer, BunPath.layer);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupInspectWorkspace = (dir: string, pgPort: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
    yield* fs.writeFileString(
      path.join(dir, "supabase", "config.toml"),
      ['project_id = "test-project"', "", "[db]", "port = " + pgPort].join("\n"),
    );
  });

const setPgFixture = (apiUrl: string, key: string) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.make("POST")(apiUrl + "/_ctrl/pg-fixture").pipe(
      HttpClientRequest.bodyJson({ key }),
    );
    const response = yield* HttpClient.execute(request);
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text;
      return yield* Effect.die(new Error('Failed to set PG fixture "' + key + '": ' + body));
    }
  });

// ---------------------------------------------------------------------------
// Subcommand table
// ---------------------------------------------------------------------------

const SUBCOMMANDS = [
  { name: "db-stats", fixtureKey: "db-stats", assertValue: "42 MB" },
  { name: "replication-slots", fixtureKey: "replication-slots", assertValue: "test-slot" },
  { name: "locks", fixtureKey: "locks", assertValue: "test-table" },
  { name: "blocking", fixtureKey: "blocking", assertValue: "test_table" },
  { name: "outliers", fixtureKey: "outliers", assertValue: "orders" },
  { name: "calls", fixtureKey: "calls", assertValue: "users" },
  { name: "index-stats", fixtureKey: "index-stats", assertValue: "users_email_idx" },
  { name: "long-running-queries", fixtureKey: "long-running-queries", assertValue: "large_table" },
  { name: "bloat", fixtureKey: "bloat", assertValue: "public.users" },
  { name: "role-stats", fixtureKey: "role-stats", assertValue: "postgres" },
  { name: "vacuum-stats", fixtureKey: "vacuum-stats", assertValue: "public.events" },
  { name: "table-stats", fixtureKey: "table-stats", assertValue: "public.orders" },
  { name: "traffic-profile", fixtureKey: "traffic-profile", assertValue: "sessions" },
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inspect:flags", () => {
  testBehaviour("rejects --db-url with --local", ({ run, workspace, pgMockPort }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupInspectWorkspace(workspace.path, pgMockPort);
        const result = yield* Effect.promise(() =>
          run([
            "inspect",
            "db",
            "db-stats",
            "--db-url",
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "--local",
          ]),
        );
        expect(result.exitCode).not.toBe(0);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

for (const { name, fixtureKey, assertValue } of SUBCOMMANDS) {
  describe("inspect:db:" + name, () => {
    testBehaviour("renders query results as a table", ({ run, workspace, apiUrl, pgMockPort }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* setupInspectWorkspace(workspace.path, pgMockPort);
          yield* setPgFixture(apiUrl, fixtureKey);
          const result = yield* Effect.promise(() => run(["inspect", "db", name, "--local"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain(assertValue);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on connection refused", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run([
              "inspect",
              "db",
              name,
              "--db-url",
              "postgresql://postgres:postgres@localhost:1/postgres",
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).not.toBe("");
        }),
      ),
    );
  });
}

describe("inspect:report", () => {
  testBehaviour("saves CSV files on success", ({ run, workspace, pgMockPort }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupInspectWorkspace(workspace.path, pgMockPort);
        const path = yield* Path.Path;
        const outDir = path.join(workspace.path, "report-out");
        const result = yield* Effect.promise(() =>
          run(["inspect", "report", "--local", "--output-dir", outDir]),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("Reports saved to");
        const fs = yield* FileSystem.FileSystem;
        const subdirs = yield* fs.readDirectory(outDir);
        expect(subdirs.length).toBe(1);
        const dateDir = subdirs[0]!;
        const csvFiles = yield* fs.readDirectory(path.join(outDir, dateDir));
        expect(csvFiles.length).toBeGreaterThan(0);
        expect(csvFiles.every((f) => f.endsWith(".csv"))).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on connection refused", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          run([
            "inspect",
            "report",
            "--db-url",
            "postgresql://postgres:postgres@localhost:1/postgres",
          ]),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).not.toBe("");
      }),
    ),
  );
});
