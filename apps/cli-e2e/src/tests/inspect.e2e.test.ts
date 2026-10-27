import { Data, Effect, FileSystem, Path } from "effect";
import { describe, expect } from "vitest";
import { postControl, runE2e, testBehaviour } from "./test-context.ts";

const setupInspectWorkspace = Effect.fnUntraced(function* (dir: string, pgPort: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
  yield* fs.writeFileString(
    path.join(dir, "supabase", "config.toml"),
    ['project_id = "test-project"', "", "[db]", `port = ${pgPort}`].join("\n"),
  );
});

/** The replay server rejected a PG mock fixture. */
class PgFixtureError extends Data.Error<{ readonly message: string }> {}

const setPgFixture = Effect.fnUntraced(function* (apiUrl: string, key: string) {
  const res = yield* postControl(`${apiUrl}/_ctrl/pg-fixture`, { key });
  if (res.status < 200 || res.status >= 300) {
    return yield* new PgFixtureError({
      message: `Failed to set PG fixture "${key}": ${yield* res.text}`,
    });
  }
});

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

describe("inspect:flags", () => {
  testBehaviour("rejects --db-url with --local", ({ run, workspace, pgMockPort, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupInspectWorkspace(workspace.path, pgMockPort);
        const result = yield* run([
          "inspect",
          "db",
          "db-stats",
          "--db-url",
          "postgresql://postgres:postgres@localhost:5432/postgres",
          "--local",
        ]);
        expect(result.exitCode).not.toBe(0);
      }),
      signal,
    ),
  );
});

for (const { name, fixtureKey, assertValue } of SUBCOMMANDS) {
  describe(`inspect:db:${name}`, () => {
    testBehaviour(
      "renders query results as a table",
      ({ run, workspace, apiUrl, pgMockPort, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* setupInspectWorkspace(workspace.path, pgMockPort);
            yield* setPgFixture(apiUrl, fixtureKey);
            const result = yield* run(["inspect", "db", name, "--local"]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(assertValue);
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on connection refused", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "inspect",
            "db",
            name,
            "--db-url",
            "postgresql://postgres:postgres@localhost:1/postgres",
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).not.toBe("");
        }),
        signal,
      ),
    );
  });
}

describe("inspect:report", () => {
  testBehaviour("saves CSV files on success", ({ run, workspace, pgMockPort, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* setupInspectWorkspace(workspace.path, pgMockPort);
        const outDir = path.join(workspace.path, "report-out");
        const result = yield* run(["inspect", "report", "--local", "--output-dir", outDir]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("Reports saved to");
        const subdirs = yield* fs.readDirectory(outDir);
        expect(subdirs.length).toBe(1);
        const dateDir = subdirs[0]!;
        const csvFiles = yield* fs.readDirectory(path.join(outDir, dateDir));
        expect(csvFiles.length).toBeGreaterThan(0);
        expect(csvFiles.every((f) => f.endsWith(".csv"))).toBe(true);
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero on connection refused", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run([
          "inspect",
          "report",
          "--db-url",
          "postgresql://postgres:postgres@localhost:1/postgres",
        ]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).not.toBe("");
      }),
      signal,
    ),
  );
});
