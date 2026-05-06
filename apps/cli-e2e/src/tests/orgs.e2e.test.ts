import { describe, expect } from "vitest";
import { isRecording } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

const ORG_NAME = "My Test Org";

describe("orgs", () => {
  describe("orgs:list", () => {
    testBehaviour("renders org data", async ({ run }) => {
      const result = await run(["orgs", "list"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ID");
      expect(result.stdout).toMatch(/[a-z]{20}|<PROJECT_REF>/);
    });

    testBehaviour("returns json output with --output json", async ({ run }) => {
      const result = await run(["orgs", "list", "--output", "json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    });

    testBehaviour("includes debug output with --debug", async ({ run }) => {
      const result = await run(["orgs", "list", "--debug"]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["orgs", "list"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["orgs", "list"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["orgs", "list"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["orgs", "list"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["orgs", "list"]);
    testParity(["orgs", "list"], { failureType: "NON_AUTH" });
  });

  describe("orgs:create", () => {
    testBehaviour.skipIf(isRecording)("creates organization with name", async ({ run }) => {
      const result = await run(["orgs", "create", ORG_NAME]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created organization:");
      expect(result.stdout).toMatch(/[a-z]{20}|<PROJECT_REF>/);
    });

    testBehaviour("exits non-zero without name in non-TTY", async ({ run }) => {
      const result = await run(["orgs", "create"]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 409 name conflict", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 409,
          body: { message: "Organization name already in use" },
        }),
      });
      const result = await run(["orgs", "create", ORG_NAME]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Organization name already in use");
    });

    testBehaviour("exits non-zero on 403 plan limit reached", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Organization limit reached" } }),
      });
      const result = await run(["orgs", "create", ORG_NAME]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Organization limit reached");
    });

    testBehaviour("exits non-zero on 422 validation error", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 422, body: { message: "Invalid organization name" } }),
      });
      const result = await run(["orgs", "create", ORG_NAME]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid organization name");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["orgs", "create", ORG_NAME]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["orgs", "create", ORG_NAME]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["orgs", "create", ORG_NAME]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["orgs", "create", "Test Org"]);
    testParity(["orgs", "create", "Test Org"], { failureType: "NON_AUTH" });
  });
});
