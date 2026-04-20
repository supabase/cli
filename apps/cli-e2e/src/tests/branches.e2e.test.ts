import { describe, expect } from "vitest";
import { isRecording, PROJECT_REF } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

const BRANCH_NAME = "my-branch";

describe("branches", () => {
  describe("branches:list", () => {
    testBehaviour("renders fixture data in output", async ({ run, projectRef }) => {
      const result = await run(["branches", "list", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("NAME");
      expect(result.stdout).toContain("STATUS");
    });

    testBehaviour("returns json output with --output json", async ({ run, projectRef }) => {
      const result = await run([
        "branches",
        "list",
        "--output",
        "json",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
    });

    testBehaviour("includes debug output with --debug", async ({ run, projectRef }) => {
      const result = await run(["branches", "list", "--debug", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/HTTP.*GET:/);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["branches", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["branches", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["branches", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["branches", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["branches", "list", "--project-ref", PROJECT_REF]);
    testParity(["branches", "list", "--project-ref", PROJECT_REF], { failureType: "NON_AUTH" });
  });

  describe("branches:create", () => {
    testBehaviour.skipIf(isRecording)("creates ephemeral branch", async ({ run, projectRef }) => {
      const result = await run(["branches", "create", BRANCH_NAME, "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created preview branch:");
    });

    testBehaviour.skipIf(isRecording)("creates persistent branch", async ({ run, projectRef }) => {
      const result = await run([
        "branches",
        "create",
        BRANCH_NAME,
        "--persistent",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created preview branch:");
    });

    testBehaviour.skipIf(isRecording)("creates branch with data", async ({ run, projectRef }) => {
      const result = await run([
        "branches",
        "create",
        BRANCH_NAME,
        "--with-data",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created preview branch:");
    });

    testBehaviour("exits non-zero on 409 name conflict", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 409, body: { message: "Branch name already in use" } }),
      });
      const result = await run(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Branch name already in use");
    });

    testBehaviour("exits non-zero on 422 branching not enabled", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 422,
          body: { message: "Preview branching is not enabled" },
        }),
      });
      const result = await run(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Preview branching is not enabled");
    });

    testBehaviour("exits non-zero on 422 invalid region", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 422, body: { message: "Invalid region" } }),
      });
      const result = await run([
        "branches",
        "create",
        BRANCH_NAME,
        "--region",
        "invalid-region",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--region");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testParity(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]);
    testParity(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("branches:get", () => {
    testBehaviour.skipIf(isRecording)(
      "returns single branch details",
      async ({ run, projectRef }) => {
        const result = await run(["branches", "get", BRANCH_NAME, "--project-ref", projectRef]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(BRANCH_NAME);
      },
    );

    testBehaviour.skipIf(isRecording)(
      "returns json output with --output json",
      async ({ run, projectRef }) => {
        const result = await run([
          "branches",
          "get",
          BRANCH_NAME,
          "--output",
          "json",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(parsed).toMatchObject({ SUPABASE_JWT_SECRET: expect.any(String) });
      },
    );

    testBehaviour("exits non-zero on 404 branch not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Branch not found" } }),
      });
      const result = await run(["branches", "get", "nonexistent", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Branch not found");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["branches", "get", BRANCH_NAME, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testParity(["branches", "get", BRANCH_NAME, "--project-ref", PROJECT_REF]);
    testParity(["branches", "get", BRANCH_NAME, "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("branches:update", () => {
    testBehaviour.skipIf(isRecording)("renames branch with --name", async ({ run, projectRef }) => {
      const result = await run([
        "branches",
        "update",
        BRANCH_NAME,
        "--name",
        "renamed-branch",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Updated preview branch:");
    });

    testBehaviour.skipIf(isRecording)(
      "changes git branch with --git-branch",
      async ({ run, projectRef }) => {
        const result = await run([
          "branches",
          "update",
          BRANCH_NAME,
          "--git-branch",
          "feature/new",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("Updated preview branch:");
      },
    );

    testBehaviour("exits non-zero on 404 branch not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Branch not found" } }),
      });
      const result = await run([
        "branches",
        "update",
        "nonexistent",
        "--name",
        "new-name",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Branch not found");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "branches",
        "update",
        BRANCH_NAME,
        "--name",
        "new-name",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });
  });

  describe("branches:pause", () => {
    testBehaviour.skipIf(isRecording)("pauses branch successfully", async ({ run, projectRef }) => {
      const result = await run(["branches", "pause", BRANCH_NAME, "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("exits non-zero on 404 branch not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Branch not found" } }),
      });
      const result = await run(["branches", "pause", "nonexistent", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Branch not found");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["branches", "pause", BRANCH_NAME, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });
  });

  describe("branches:unpause", () => {
    testBehaviour.skipIf(isRecording)(
      "unpauses branch successfully",
      async ({ run, projectRef }) => {
        const result = await run(["branches", "unpause", BRANCH_NAME, "--project-ref", projectRef]);
        expect(result.exitCode).toBe(0);
      },
    );

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["branches", "unpause", BRANCH_NAME, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });
  });

  describe("branches:delete", () => {
    testBehaviour.skipIf(isRecording)(
      "deletes branch successfully",
      async ({ run, projectRef }) => {
        const result = await run(["branches", "delete", BRANCH_NAME, "--project-ref", projectRef]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("Deleted preview branch:");
      },
    );

    testBehaviour("exits non-zero on 404 branch not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Branch not found" } }),
      });
      const result = await run(["branches", "delete", "nonexistent", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Branch not found");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["branches", "delete", BRANCH_NAME, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testParity(["branches", "delete", BRANCH_NAME, "--project-ref", PROJECT_REF]);
    testParity(["branches", "delete", BRANCH_NAME, "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("branches:disable", () => {
    testBehaviour.skipIf(isRecording)("disables preview branching", async ({ run, projectRef }) => {
      const result = await run(["branches", "disable", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Disabled preview branching for project:");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["branches", "disable", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });
  });
});
