import { describe, expect } from "vitest";
import { isRecording, PROJECT_REF } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

const FUNCTION_NAME = "hello-world";

describe("functions", () => {
  describe("functions:list", () => {
    testBehaviour("renders fixture data in output", async ({ run, projectRef }) => {
      const result = await run(["functions", "list", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("NAME");
      expect(result.stdout).toContain("STATUS");
    });

    testBehaviour("returns json output with --output json", async ({ run, projectRef }) => {
      const result = await run([
        "functions",
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
      const result = await run(["functions", "list", "--debug", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/HTTP.*GET:/);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["functions", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["functions", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["functions", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["functions", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["functions", "list", "--project-ref", PROJECT_REF]);
    testParity(["functions", "list", "--project-ref", PROJECT_REF], { failureType: "NON_AUTH" });
  });

  describe("functions:deploy", () => {
    // Deploy requires the Go binary to bundle function files locally before any API call,
    // so error injection tests pre-create the function with `functions new` first.

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await run(["functions", "new", FUNCTION_NAME]);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "functions",
        "deploy",
        FUNCTION_NAME,
        "--use-api",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await run(["functions", "new", FUNCTION_NAME]);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run([
        "functions",
        "deploy",
        FUNCTION_NAME,
        "--use-api",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await run(["functions", "new", FUNCTION_NAME]);
      await fetch(`${apiUrl}/_ctrl/rate-limit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/v1/projects/${PROJECT_REF}/functions/deploy`,
          retryAfterSeconds: 0,
        }),
      });
      const result = await run([
        "functions",
        "deploy",
        FUNCTION_NAME,
        "--use-api",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await run(["functions", "new", FUNCTION_NAME]);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run([
        "functions",
        "deploy",
        FUNCTION_NAME,
        "--use-api",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["functions", "deploy", FUNCTION_NAME, "--use-api", "--project-ref", PROJECT_REF]);
    testParity(["functions", "deploy", FUNCTION_NAME, "--use-api", "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("functions:delete", () => {
    testBehaviour.skipIf(isRecording)(
      "deletes function successfully",
      async ({ run, projectRef }) => {
        const result = await run([
          "functions",
          "delete",
          FUNCTION_NAME,
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Deleted Function");
      },
    );

    testBehaviour("exits non-zero on 404 function not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Function not found" } }),
      });
      const result = await run([
        "functions",
        "delete",
        FUNCTION_NAME,
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("does not exist");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "functions",
        "delete",
        FUNCTION_NAME,
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run([
        "functions",
        "delete",
        FUNCTION_NAME,
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
        "functions",
        "delete",
        FUNCTION_NAME,
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run([
        "functions",
        "delete",
        FUNCTION_NAME,
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["functions", "delete", FUNCTION_NAME, "--project-ref", PROJECT_REF]);
    testParity(["functions", "delete", FUNCTION_NAME, "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("functions:download", () => {
    testBehaviour.skipIf(isRecording)(
      "downloads function successfully",
      async ({ run, projectRef }) => {
        const result = await run([
          "functions",
          "download",
          FUNCTION_NAME,
          "--use-api",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("Downloaded Function");
      },
    );

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "functions",
        "download",
        FUNCTION_NAME,
        "--use-api",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run([
        "functions",
        "download",
        FUNCTION_NAME,
        "--use-api",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 function not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Function not found" } }),
      });
      const result = await run([
        "functions",
        "download",
        FUNCTION_NAME,
        "--use-api",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Function not found");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run([
        "functions",
        "download",
        FUNCTION_NAME,
        "--use-api",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(
      ["functions", "download", FUNCTION_NAME, "--use-api", "--project-ref", PROJECT_REF],
      { failureType: "NON_AUTH" },
    );
  });

  describe("functions:new", () => {
    testBehaviour("successfully creates a new function", async ({ run }) => {
      const result = await run(["functions", "new", "testFunction"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created new Function at supabase/functions/testFunction");
    });

    testParity(["functions", "new", "testFunction"]);
  });
});
