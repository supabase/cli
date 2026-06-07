import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { testBehaviour, testParity } from "./test-context.ts";

const MIGRATION_NAME = "my_change";

describe("migrations", () => {
  describe("migration:new", () => {
    testBehaviour("creates timestamped sql file", async ({ run, workspace }) => {
      const result = await run(["migration", "new", MIGRATION_NAME]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created new migration at");
      const files = readdirSync(join(workspace.path, "supabase", "migrations"));
      expect(files.some((f) => f.endsWith(`_${MIGRATION_NAME}.sql`))).toBe(true);
    });

    testBehaviour("exits non-zero without name argument", async ({ run }) => {
      const result = await run(["migration", "new"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("migration name");
    });
  });

  describe("migration:list", () => {
    testBehaviour("exits non-zero on connection refused", async ({ run }) => {
      const result = await run(["migration", "list", "--local"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("failed to connect");
    });

    testParity(["migration", "list", "--local"]);
  });

  describe("migration:up", () => {
    testBehaviour("exits non-zero on connection refused", async ({ run }) => {
      const result = await run(["migration", "up", "--local"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("failed to connect");
    });

    testParity(["migration", "up", "--local"]);
  });

  describe("migration:down", () => {
    testBehaviour("exits non-zero on connection refused", async ({ run }) => {
      const result = await run(["migration", "down", "--local"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("failed to connect");
    });

    testBehaviour("exits non-zero on connection refused with --last 2", async ({ run }) => {
      const result = await run(["migration", "down", "--last", "2", "--local"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("failed to connect");
    });

    testParity(["migration", "down", "--local"]);
    testParity(["migration", "down", "--last", "2", "--local"]);
  });

  describe("migration:repair", () => {
    testBehaviour("exits non-zero when --status flag is missing", async ({ run }) => {
      const result = await run(["migration", "repair", "--local", "20230101000000"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--status");
    });

    testBehaviour("exits non-zero on connection refused", async ({ run }) => {
      const result = await run([
        "migration",
        "repair",
        "--status",
        "applied",
        "--local",
        "20230101000000",
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("failed to connect");
    });

    testParity(["migration", "repair", "--status", "applied", "--local", "20230101000000"]);
  });

  describe("migration:squash", () => {
    testBehaviour("exits non-zero on connection refused", async ({ run }) => {
      const result = await run(["migration", "squash", "--local"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe("");
    });

    testParity(["migration", "squash", "--local"]);
  });

  describe("migration:fetch", () => {
    testBehaviour("exits non-zero on connection refused", async ({ run }) => {
      const result = await run(["migration", "fetch", "--local"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("failed to connect");
    });

    testParity(["migration", "fetch", "--local"]);
  });
});
