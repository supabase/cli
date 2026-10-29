import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { linkProject } from "./link-project.ts";
import { testBehaviour } from "./test-context.ts";

const TEST_MIGRATION_SQL =
  "CREATE TABLE IF NOT EXISTS e2e_test_table (id bigint generated always as identity primary key);";

/** Create a single migration file in supabase/migrations/ and return the SQL. */
function seedMigration(dir: string): void {
  const migrationsDir = join(dir, "supabase", "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(join(migrationsDir, "20240101000000_e2e_test.sql"), TEST_MIGRATION_SQL);
}

describe("db advisors", () => {
  describe("db advisors:security", () => {
    testBehaviour("returns security advisors", async ({ run, projectRef, workspace }) => {
      linkProject(workspace.path, projectRef);
      const result = await run(["db", "advisors", "--type", "security", "--remote"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
      expect(result.stderr).toContain("No issues found");
    });

    testBehaviour(
      "exits zero when --fail-on error and no error-level advisors found",
      async ({ run, projectRef, workspace }) => {
        linkProject(workspace.path, projectRef);
        const result = await run([
          "db",
          "advisors",
          "--type",
          "security",
          "--fail-on",
          "error",
          "--remote",
        ]);
        expect(result.exitCode).toBe(0);
      },
    );

    testBehaviour("exits non-zero on 401", async ({ run, projectRef, apiUrl, workspace }) => {
      linkProject(workspace.path, projectRef);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["db", "advisors", "--type", "security", "--remote"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, projectRef, apiUrl, workspace }) => {
      linkProject(workspace.path, projectRef);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["db", "advisors", "--type", "security", "--remote"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 429", async ({ run, projectRef, apiUrl, workspace }) => {
      linkProject(workspace.path, projectRef);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["db", "advisors", "--type", "security", "--remote"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, projectRef, apiUrl, workspace }) => {
      linkProject(workspace.path, projectRef);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["db", "advisors", "--type", "security", "--remote"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });
  });

  describe("db advisors:performance", () => {
    testBehaviour("returns performance advisors", async ({ run, projectRef, workspace }) => {
      linkProject(workspace.path, projectRef);
      const result = await run(["db", "advisors", "--type", "performance", "--remote"]);
      expect(result.exitCode).toBe(0);
      if (result.stdout.trim()) {
        const parsed = JSON.parse(result.stdout) as unknown[];
        expect(Array.isArray(parsed)).toBe(true);
      } else {
        expect(result.stderr).toContain("No issues found");
      }
    });
  });

  describe("db advisors:all", () => {
    testBehaviour("returns advisors with --type all", async ({ run, projectRef, workspace }) => {
      linkProject(workspace.path, projectRef);
      const result = await run(["db", "advisors", "--type", "all", "--remote"]);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("db query", () => {
  describe("db query:remote", () => {
    testBehaviour(
      "returns SELECT 1 result in table format",
      async ({ run, projectRef, workspace }) => {
        linkProject(workspace.path, projectRef);
        const result = await run(["db", "query", "SELECT 1", "--read-only", "--remote"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("1");
      },
    );

    testBehaviour("returns JSON with --output json", async ({ run, projectRef, workspace }) => {
      linkProject(workspace.path, projectRef);
      const result = await run([
        "db",
        "query",
        "--output",
        "json",
        "SELECT 1",
        "--read-only",
        "--remote",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as unknown;
      // In agent mode (CLAUDECODE env set) the output is wrapped in {warning, boundary, rows}.
      // In normal mode it's a plain array.
      const rows = Array.isArray(parsed) ? parsed : (parsed as { rows: unknown[] }).rows;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(1);
    });

    testBehaviour("exits non-zero on 401", async ({ run, projectRef, apiUrl, workspace }) => {
      linkProject(workspace.path, projectRef);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["db", "query", "SELECT 1", "--read-only", "--remote"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, projectRef, apiUrl, workspace }) => {
      linkProject(workspace.path, projectRef);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["db", "query", "SELECT 1", "--read-only", "--remote"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });
  });
});

describe("db push", () => {
  describe("db push:dry-run", () => {
    testBehaviour(
      "exits non-zero on connection refused with --dry-run",
      async ({ run, projectRef, workspace }) => {
        linkProject(workspace.path, projectRef);
        seedMigration(workspace.path);
        const result = await run(["db", "push", "--dry-run", "--remote"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("connect");
      },
    );
  });

  describe("db push:local", () => {
    testBehaviour("exits non-zero on connection refused without --remote", async ({ run }) => {
      const result = await run(["db", "push"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("connect");
    });
  });

  describe("db push:remote", () => {
    testBehaviour(
      "exits non-zero on connection refused with --remote",
      async ({ run, projectRef, workspace }) => {
        linkProject(workspace.path, projectRef);
        const result = await run(["db", "push", "--remote"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("connect");
      },
    );
  });
});

describe("db pull", () => {
  testBehaviour("exits non-zero on connection refused without --remote", async ({ run }) => {
    const result = await run(["db", "pull"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("connect");
  });
});

describe("db lint", () => {
  testBehaviour("exits non-zero on connection refused without --remote", async ({ run }) => {
    const result = await run(["db", "lint"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("connect");
  });
});

describe("db dump", () => {
  testBehaviour("exits non-zero on connection refused without --remote", async ({ run }) => {
    const result = await run(["db", "dump"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("connect");
  });

  testBehaviour("exits non-zero when --role-only and --data-only are both set", async ({ run }) => {
    const result = await run(["db", "dump", "--role-only", "--data-only"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toMatch(/role.only|data.only|mutually exclusive/);
  });
});

describe("db reset", () => {
  testBehaviour("exits non-zero on connection refused without --remote", async ({ run }) => {
    const result = await run(["db", "reset"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/connect|not running/i);
  });
});

describe("test new", () => {
  testBehaviour("creates a pgTAP test file", async ({ run, workspace }) => {
    const result = await run(["test", "new", "my_test"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/my_test/);
    const files = readdirSync(join(workspace.path, "supabase", "tests")).filter((f) =>
      f.endsWith("my_test_test.sql"),
    );
    expect(files.length).toBe(1);
  });

  testBehaviour("exits non-zero when name argument is missing", async ({ run }) => {
    const result = await run(["test", "new"]);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("test db", () => {
  testBehaviour("exits non-zero on connection refused without --remote", async ({ run }) => {
    const result = await run(["test", "db"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("connect");
  });
});
