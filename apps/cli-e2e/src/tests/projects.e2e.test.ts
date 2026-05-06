import { describe, expect } from "vitest";
import { isRecording, PROJECT_REF } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

describe("projects", () => {
  describe("projects:list", () => {
    testBehaviour("renders project list", async ({ run }) => {
      const result = await run(["projects", "list"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/[a-z]{20}|<PROJECT_REF>/);
      expect(result.stdout).toContain("REFERENCE ID");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["projects", "list"]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("returns json output with --output json", async ({ run }) => {
      const result = await run(["projects", "list", "--output", "json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toMatchObject({ name: expect.any(String), ref: expect.any(String) });
    });

    testBehaviour("includes debug output with --debug", async ({ run }) => {
      const result = await run(["projects", "list", "--debug"]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["projects", "list"]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["projects", "list"]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["projects", "list"]);
      expect(result.exitCode).not.toBe(0);
    });

    testParity(["projects", "list"]);
    testParity(["projects", "list"], { failureType: "NON_AUTH" });
  });

  describe("projects:api-keys", () => {
    testBehaviour("shows default and anon keys", async ({ run, projectRef }) => {
      const result = await run(["projects", "api-keys", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("NAME");
      expect(result.stdout).toContain("KEY VALUE");
      expect(result.stdout).toContain("anon");
      expect(result.stdout).toContain("default");
    });

    testBehaviour("returns json output with --output json", async ({ run, projectRef }) => {
      const result = await run([
        "projects",
        "api-keys",
        "--output",
        "json",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toEqual(expect.arrayContaining([expect.objectContaining({ name: "anon" })]));
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["projects", "api-keys", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["projects", "api-keys", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run(["projects", "api-keys", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
    });

    testParity(["projects", "api-keys", "--project-ref", PROJECT_REF]);
    testParity(["projects", "api-keys", "--project-ref", PROJECT_REF], { failureType: "NON_AUTH" });
  });

  describe("projects:create", () => {
    testBehaviour("creates project with required flags", async ({ run, orgId }) => {
      const result = await run([
        "projects",
        "create",
        "my-project",
        "--org-id",
        orgId,
        "--db-password",
        "password123",
        "--region",
        "us-east-1",
        "--size",
        "micro",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("REFERENCE ID");
    });

    testBehaviour("exits non-zero without required flags in non-TTY", async ({ run }) => {
      const result = await run(["projects", "create", "--org-id", "test-org-id"]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 409 name conflict", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 409, body: { message: "Project name already in use" } }),
      });
      const result = await run([
        "projects",
        "create",
        "my-project",
        "--org-id",
        "test-org-id",
        "--db-password",
        "password123",
        "--region",
        "us-east-1",
      ]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 422 validation error", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 422,
          body: {
            message: "Validation failed",
            errors: [{ field: "region", message: "Invalid region" }],
          },
        }),
      });
      const result = await run([
        "projects",
        "create",
        "my-project",
        "--org-id",
        "test-org-id",
        "--db-password",
        "password123",
        "--region",
        "us-east-1",
      ]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 403 no org access", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run([
        "projects",
        "create",
        "my-project",
        "--org-id",
        "test-org-id",
        "--db-password",
        "password123",
        "--region",
        "us-east-1",
      ]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "projects",
        "create",
        "my-project",
        "--org-id",
        "test-org-id",
        "--db-password",
        "password123",
        "--region",
        "us-east-1",
      ]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
        "projects",
        "create",
        "my-project",
        "--org-id",
        "test-org-id",
        "--db-password",
        "password123",
        "--region",
        "us-east-1",
      ]);
      expect(result.exitCode).not.toBe(0);
    });

    testParity([
      "projects",
      "create",
      "my-project",
      "--org-id",
      "test-org-id",
      "--db-password",
      "password123",
      "--region",
      "us-east-1",
      "--size",
      "micro",
    ]);
    testParity(
      [
        "projects",
        "create",
        "my-project",
        "--org-id",
        "test-org-id",
        "--db-password",
        "password123",
        "--region",
        "us-east-1",
        "--size",
        "micro",
      ],
      { failureType: "NON_AUTH" },
    );
  });

  describe("projects:delete", () => {
    testBehaviour.skipIf(isRecording)(
      "returns 400 when project not ready for deletion",
      async ({ run, apiUrl }) => {
        await fetch(`${apiUrl}/_ctrl/error-all`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: 400,
            body: { message: "Project not ready for deletion." },
          }),
        });
        const result = await run(["projects", "delete", PROJECT_REF, "--yes"]);
        expect(result.exitCode).not.toBe(0);
      },
    );

    testBehaviour.skipIf(isRecording)(
      "deletes project with --yes flag",
      async ({ run, projectRef }) => {
        const result = await run(["projects", "delete", projectRef, "--yes"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Deleted project");
      },
    );

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run(["projects", "delete", PROJECT_REF, "--yes"]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["projects", "delete", PROJECT_REF, "--yes"]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["projects", "delete", PROJECT_REF, "--yes"]);
      expect(result.exitCode).not.toBe(0);
    });

    testParity(["projects", "delete", PROJECT_REF, "--yes"]);
    testParity(["projects", "delete", PROJECT_REF, "--yes"], { failureType: "NON_AUTH" });
  });
});
