import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

describe("secrets", () => {
  describe("secrets:list", () => {
    testBehaviour("renders fixture data in output", async ({ run, projectRef }) => {
      const result = await run(["secrets", "list", `--remote=${projectRef}`]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("NAME");
      expect(result.stdout).toContain("DIGEST");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["secrets", "list", `--remote=${PROJECT_REF}`]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("returns json output with --output json", async ({ run, projectRef }) => {
      const result = await run(["secrets", "list", "--output", "json", `--remote=${projectRef}`]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["secrets", "list", `--remote=${PROJECT_REF}`]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run(["secrets", "list", `--remote=${PROJECT_REF}`]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["secrets", "list", `--remote=${PROJECT_REF}`]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["secrets", "list", `--remote=${PROJECT_REF}`]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("includes debug output with --debug", async ({ run, projectRef }) => {
      const result = await run(["secrets", "list", "--debug", `--remote=${projectRef}`]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("secrets:set", () => {
    testBehaviour("sets a single secret", async ({ run, projectRef }) => {
      const result = await run(["secrets", "set", "FOO=bar", "--yes", `--remote=${projectRef}`]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Finished");
    });

    testBehaviour("sets multiple secrets", async ({ run, projectRef }) => {
      const result = await run([
        "secrets",
        "set",
        "FOO=bar",
        "BAZ=qux",
        "--yes",
        `--remote=${projectRef}`,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Finished");
    });

    testBehaviour("sets secrets from env file", async ({ run, workspace, projectRef }) => {
      writeFileSync(join(workspace.path, ".env.local"), "FOO=bar\n");
      const result = await run([
        "secrets",
        "set",
        "--env-file",
        ".env.local",
        "--yes",
        `--remote=${projectRef}`,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Finished");
    });

    testBehaviour("exits non-zero on 422 invalid name", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 422,
          body: { message: "Validation failed", errors: [{ message: "Invalid secret name" }] },
        }),
      });
      const result = await run(["secrets", "set", "FOO=bar", "--yes", `--remote=${PROJECT_REF}`]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero when env file not found", async ({ run }) => {
      const result = await run([
        "secrets",
        "set",
        "--env-file",
        "nonexistent.env",
        "--yes",
        `--remote=${PROJECT_REF}`,
      ]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["secrets", "set", "FOO=bar", "--yes", `--remote=${PROJECT_REF}`]);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("secrets:unset", () => {
    testBehaviour("removes a secret", async ({ run, projectRef }) => {
      const result = await run(["secrets", "unset", "FOO", "--yes", `--remote=${projectRef}`]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Finished");
    });

    testBehaviour("removes multiple secrets", async ({ run, projectRef }) => {
      await run(["secrets", "set", "FOO=bar", "BAR=baz", "--yes", `--remote=${projectRef}`]);
      const result = await run([
        "secrets",
        "unset",
        "FOO",
        "BAR",
        "--yes",
        `--remote=${projectRef}`,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Finished");
    });

    testBehaviour("exits non-zero on 404", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Secret not found" } }),
      });
      const result = await run([
        "secrets",
        "unset",
        "NONEXISTENT",
        "--yes",
        `--remote=${PROJECT_REF}`,
      ]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["secrets", "unset", "FOO", "--yes", `--remote=${PROJECT_REF}`]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["secrets", "unset", "FOO", "--yes", `--remote=${PROJECT_REF}`]);
      expect(result.exitCode).not.toBe(0);
    });
  });
});
