import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, inject, test } from "vitest";
import { ACCESS_TOKEN, isRecording } from "./env.ts";
import { runParity } from "@supabase/cli-test-helpers";
import { testBehaviour } from "./test-context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupInspectWorkspace(dir: string, pgPort: number): void {
  mkdirSync(join(dir, "supabase"), { recursive: true });
  writeFileSync(
    join(dir, "supabase", "config.toml"),
    ['project_id = "test-project"', "", "[db]", `port = ${pgPort}`].join("\n"),
  );
}

async function setPgFixture(apiUrl: string, key: string): Promise<void> {
  const res = await fetch(`${apiUrl}/_ctrl/pg-fixture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) throw new Error(`Failed to set PG fixture "${key}": ${await res.text()}`);
}

/** Parity test that sets a PG fixture before running both CLIs. */
function testInspectDbParity(subcmd: string, fixtureKey: string): void {
  test.skipIf(isRecording)(`parity: inspect db ${subcmd}`, async () => {
    const serverUrl = inject("replayServerUrl") as string;
    const pgMockPort = inject("pgMockPort") as number;

    await setPgFixture(serverUrl, fixtureKey);

    try {
      await runParity(
        {
          apiUrl: serverUrl,
          accessToken: ACCESS_TOKEN,
          workspaceSetup: (dir) => setupInspectWorkspace(dir, pgMockPort),
        },
        ["inspect", "db", subcmd, "--local"],
      );
    } finally {
      await fetch(`${serverUrl}/_ctrl/overrides`, { method: "DELETE" });
    }
  });
}

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
  testBehaviour("rejects --db-url with --local", async ({ run, workspace, pgMockPort }) => {
    setupInspectWorkspace(workspace.path, pgMockPort);
    const result = await run([
      "inspect",
      "db",
      "db-stats",
      "--db-url",
      "postgresql://postgres:postgres@localhost:5432/postgres",
      "--local",
    ]);
    expect(result.exitCode).not.toBe(0);
  });

  test.skipIf(isRecording)("parity: inspect db db-stats [mutually exclusive flags]", async () => {
    const serverUrl = inject("replayServerUrl") as string;
    const pgMockPort = inject("pgMockPort") as number;
    await runParity(
      {
        apiUrl: serverUrl,
        accessToken: ACCESS_TOKEN,
        workspaceSetup: (dir) => setupInspectWorkspace(dir, pgMockPort),
      },
      [
        "inspect",
        "db",
        "db-stats",
        "--db-url",
        "postgresql://postgres:postgres@localhost:5432/postgres",
        "--local",
      ],
    );
  });
});

for (const { name, fixtureKey, assertValue } of SUBCOMMANDS) {
  describe(`inspect:db:${name}`, () => {
    testBehaviour(
      "renders query results as a table",
      async ({ run, workspace, apiUrl, pgMockPort }) => {
        setupInspectWorkspace(workspace.path, pgMockPort);
        await setPgFixture(apiUrl, fixtureKey);
        const result = await run(["inspect", "db", name, "--local"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(assertValue);
      },
    );

    testBehaviour("exits non-zero on connection refused", async ({ run }) => {
      const result = await run([
        "inspect",
        "db",
        name,
        "--db-url",
        "postgresql://postgres:postgres@localhost:1/postgres",
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe("");
    });

    testInspectDbParity(name, fixtureKey);
  });
}

describe("inspect:report", () => {
  testBehaviour("saves CSV files on success", async ({ run, workspace, pgMockPort }) => {
    setupInspectWorkspace(workspace.path, pgMockPort);
    const outDir = join(workspace.path, "report-out");
    const result = await run(["inspect", "report", "--local", "--output-dir", outDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Reports saved to");
    const subdirs = readdirSync(outDir);
    expect(subdirs.length).toBe(1);
    const dateDir = subdirs[0]!;
    const csvFiles = readdirSync(join(outDir, dateDir));
    expect(csvFiles.length).toBeGreaterThan(0);
    expect(csvFiles.every((f) => f.endsWith(".csv"))).toBe(true);
  });

  testBehaviour("exits non-zero on connection refused", async ({ run }) => {
    const result = await run([
      "inspect",
      "report",
      "--db-url",
      "postgresql://postgres:postgres@localhost:1/postgres",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toBe("");
  });

  test.skipIf(isRecording)("parity: inspect report", async () => {
    const serverUrl = inject("replayServerUrl") as string;
    const pgMockPort = inject("pgMockPort") as number;
    await runParity(
      {
        apiUrl: serverUrl,
        accessToken: ACCESS_TOKEN,
        workspaceSetup: (dir) => setupInspectWorkspace(dir, pgMockPort),
      },
      ["inspect", "report", "--local"],
    );
  });
});
