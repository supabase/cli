import { describe, expect } from "vitest";
import { BACKUP_TIMESTAMP, PROJECT_REF, SNIPPET_ID, isRecording } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

describe("postgres-config", () => {
  describe("postgres-config:get", () => {
    testBehaviour("renders config overrides", async ({ run, projectRef }) => {
      const result = await run([
        "postgres-config",
        "get",
        "--experimental",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toBe("");
    });

    testBehaviour(
      "returns config overrides as JSON with --output json",
      async ({ run, projectRef }) => {
        const result = await run([
          "postgres-config",
          "get",
          "--experimental",
          "--output",
          "json",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).not.toBeNull();
        expect(typeof parsed).toBe("object");
      },
    );

    testBehaviour("--debug shows HTTP trace", async ({ run, projectRef }) => {
      const result = await run([
        "postgres-config",
        "get",
        "--experimental",
        "--debug",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/HTTP.*GET:/);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "postgres-config",
        "get",
        "--experimental",
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
        "postgres-config",
        "get",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run([
        "postgres-config",
        "get",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
        "postgres-config",
        "get",
        "--experimental",
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
        "postgres-config",
        "get",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["postgres-config", "get", "--experimental", "--project-ref", PROJECT_REF], {
      sortStdoutRows: true,
    });
    testParity(["postgres-config", "get", "--experimental", "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
      sortStdoutRows: true,
    });
  });

  describe("postgres-config:update", () => {
    testBehaviour("sets single config override", async ({ run, projectRef }) => {
      const result = await run([
        "postgres-config",
        "update",
        "--experimental",
        "--config",
        "max_connections=200",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("sets multiple config overrides", async ({ run, projectRef }) => {
      const result = await run([
        "postgres-config",
        "update",
        "--experimental",
        "--config",
        "max_connections=200",
        "--config",
        "shared_buffers=256MB",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour(
      "--replace-existing-overrides replaces all overrides",
      async ({ run, projectRef }) => {
        const result = await run([
          "postgres-config",
          "update",
          "--experimental",
          "--config",
          "max_connections=200",
          "--replace-existing-overrides",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
      },
    );

    testBehaviour(
      "--no-restart applies config without restarting postgres",
      async ({ run, projectRef }) => {
        const result = await run([
          "postgres-config",
          "update",
          "--experimental",
          "--config",
          "max_connections=200",
          "--no-restart",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
      },
    );

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "postgres-config",
        "update",
        "--experimental",
        "--config",
        "max_connections=200",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run([
        "postgres-config",
        "update",
        "--experimental",
        "--config",
        "max_connections=200",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 422 unrecognized config key", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 422,
          body: { message: "unrecognized config key: invalid_key" },
        }),
      });
      const result = await run([
        "postgres-config",
        "update",
        "--experimental",
        "--config",
        "invalid_key=value",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unrecognized config key");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
        "postgres-config",
        "update",
        "--experimental",
        "--config",
        "max_connections=200",
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
        "postgres-config",
        "update",
        "--experimental",
        "--config",
        "max_connections=200",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity([
      "postgres-config",
      "update",
      "--experimental",
      "--config",
      "max_connections=200",
      "--project-ref",
      PROJECT_REF,
    ]);
    testParity(
      [
        "postgres-config",
        "update",
        "--experimental",
        "--config",
        "max_connections=200",
        "--project-ref",
        PROJECT_REF,
      ],
      { failureType: "NON_AUTH" },
    );
  });

  describe("postgres-config:delete", () => {
    testBehaviour("removes config override", async ({ run, projectRef }) => {
      const result = await run([
        "postgres-config",
        "delete",
        "--experimental",
        "--config",
        "max_connections",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("removes multiple config keys", async ({ run, projectRef }) => {
      const result = await run([
        "postgres-config",
        "delete",
        "--experimental",
        "--config",
        "max_connections",
        "--config",
        "shared_buffers",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour(
      "--no-restart removes config without restarting postgres",
      async ({ run, projectRef }) => {
        const result = await run([
          "postgres-config",
          "delete",
          "--experimental",
          "--config",
          "max_connections",
          "--no-restart",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
      },
    );

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "postgres-config",
        "delete",
        "--experimental",
        "--config",
        "max_connections",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run([
        "postgres-config",
        "delete",
        "--experimental",
        "--config",
        "max_connections",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
        "postgres-config",
        "delete",
        "--experimental",
        "--config",
        "max_connections",
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
        "postgres-config",
        "delete",
        "--experimental",
        "--config",
        "max_connections",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity([
      "postgres-config",
      "delete",
      "--experimental",
      "--config",
      "max_connections",
      "--project-ref",
      PROJECT_REF,
    ]);
    testParity(
      [
        "postgres-config",
        "delete",
        "--experimental",
        "--config",
        "max_connections",
        "--project-ref",
        PROJECT_REF,
      ],
      { failureType: "NON_AUTH" },
    );
  });
});

describe("vanity-subdomains", () => {
  describe("vanity-subdomains:get", () => {
    testBehaviour("renders vanity subdomain and status", async ({ run, projectRef }) => {
      const result = await run([
        "vanity-subdomains",
        "get",
        "--experimental",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toBe("");
    });

    testBehaviour(
      "returns subdomain config as JSON with --output json",
      async ({ run, projectRef }) => {
        const result = await run([
          "vanity-subdomains",
          "get",
          "--experimental",
          "--output",
          "json",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveProperty("status");
      },
    );

    testBehaviour("--debug shows HTTP trace", async ({ run, projectRef }) => {
      const result = await run([
        "vanity-subdomains",
        "get",
        "--experimental",
        "--debug",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/HTTP.*GET:/);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "get",
        "--experimental",
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
        "vanity-subdomains",
        "get",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "get",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "get",
        "--experimental",
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
        "vanity-subdomains",
        "get",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["vanity-subdomains", "get", "--experimental", "--project-ref", PROJECT_REF]);
    testParity(["vanity-subdomains", "get", "--experimental", "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("vanity-subdomains:check-availability", () => {
    testBehaviour("reports availability for desired subdomain", async ({ run, projectRef }) => {
      const result = await run([
        "vanity-subdomains",
        "check-availability",
        "--experimental",
        "--desired-subdomain",
        "myapp",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toBe("");
    });

    testBehaviour(
      "returns availability as JSON with --output json",
      async ({ run, projectRef }) => {
        const result = await run([
          "vanity-subdomains",
          "check-availability",
          "--experimental",
          "--desired-subdomain",
          "myapp",
          "--output",
          "json",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveProperty("available");
      },
    );

    testBehaviour("exits non-zero without --desired-subdomain flag", async ({ run }) => {
      const result = await run([
        "vanity-subdomains",
        "check-availability",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero on 409 subdomain taken", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 409,
          body: { message: "Subdomain already taken" },
        }),
      });
      const result = await run([
        "vanity-subdomains",
        "check-availability",
        "--experimental",
        "--desired-subdomain",
        "taken",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("already taken");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "check-availability",
        "--experimental",
        "--desired-subdomain",
        "myapp",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "check-availability",
        "--experimental",
        "--desired-subdomain",
        "myapp",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "check-availability",
        "--experimental",
        "--desired-subdomain",
        "myapp",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testParity([
      "vanity-subdomains",
      "check-availability",
      "--experimental",
      "--desired-subdomain",
      "myapp",
      "--project-ref",
      PROJECT_REF,
    ]);
    testParity(
      [
        "vanity-subdomains",
        "check-availability",
        "--experimental",
        "--desired-subdomain",
        "myapp",
        "--project-ref",
        PROJECT_REF,
      ],
      { failureType: "NON_AUTH" },
    );
  });

  describe("vanity-subdomains:activate", () => {
    testBehaviour("activates desired vanity subdomain", async ({ run, projectRef }) => {
      const result = await run([
        "vanity-subdomains",
        "activate",
        "--experimental",
        "--desired-subdomain",
        "myapp",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Activated vanity subdomain");
    });

    testBehaviour("exits non-zero on 409 subdomain already taken", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 409,
          body: { message: "Subdomain already taken" },
        }),
      });
      const result = await run([
        "vanity-subdomains",
        "activate",
        "--experimental",
        "--desired-subdomain",
        "taken",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("already taken");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "activate",
        "--experimental",
        "--desired-subdomain",
        "myapp",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "activate",
        "--experimental",
        "--desired-subdomain",
        "myapp",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "activate",
        "--experimental",
        "--desired-subdomain",
        "myapp",
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
        "vanity-subdomains",
        "activate",
        "--experimental",
        "--desired-subdomain",
        "myapp",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity([
      "vanity-subdomains",
      "activate",
      "--experimental",
      "--desired-subdomain",
      "myapp",
      "--project-ref",
      PROJECT_REF,
    ]);
    testParity(
      [
        "vanity-subdomains",
        "activate",
        "--experimental",
        "--desired-subdomain",
        "myapp",
        "--project-ref",
        PROJECT_REF,
      ],
      { failureType: "NON_AUTH" },
    );
  });

  describe("vanity-subdomains:delete", () => {
    testBehaviour("removes vanity subdomain", async ({ run, projectRef }) => {
      const result = await run([
        "vanity-subdomains",
        "delete",
        "--experimental",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Deleted vanity subdomain");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "delete",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "delete",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
        "vanity-subdomains",
        "delete",
        "--experimental",
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
        "vanity-subdomains",
        "delete",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["vanity-subdomains", "delete", "--experimental", "--project-ref", PROJECT_REF]);
    testParity(["vanity-subdomains", "delete", "--experimental", "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });
});

describe("encryption", () => {
  describe("encryption:get-root-key", () => {
    testBehaviour("renders root encryption key", async ({ run, projectRef }) => {
      const result = await run(["encryption", "get-root-key", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toBe("");
    });

    testBehaviour("returns root_key as JSON with --output json", async ({ run, projectRef }) => {
      const result = await run([
        "encryption",
        "get-root-key",
        "--output",
        "json",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("--debug shows HTTP trace", async ({ run, projectRef }) => {
      const result = await run([
        "encryption",
        "get-root-key",
        "--debug",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/HTTP.*GET:/);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["encryption", "get-root-key", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["encryption", "get-root-key", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run(["encryption", "get-root-key", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["encryption", "get-root-key", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["encryption", "get-root-key", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["encryption", "get-root-key", "--project-ref", PROJECT_REF]);
    testParity(["encryption", "get-root-key", "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("encryption:update-root-key", () => {
    testBehaviour.skipIf(isRecording)("rotates the vault root key", async ({ run, projectRef }) => {
      const result = await run(["encryption", "update-root-key", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["encryption", "update-root-key", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["encryption", "update-root-key", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run(["encryption", "update-root-key", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["encryption", "update-root-key", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["encryption", "update-root-key", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["encryption", "update-root-key", "--project-ref", PROJECT_REF]);
    testParity(["encryption", "update-root-key", "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });
});

describe("backups", () => {
  describe("backups:list", () => {
    testBehaviour("renders backup table with REGION column", async ({ run, projectRef }) => {
      const result = await run(["backups", "list", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("REGION");
    });

    testBehaviour(
      "returns backup response as JSON with --output json",
      async ({ run, projectRef }) => {
        const result = await run([
          "backups",
          "list",
          "--output",
          "json",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveProperty("region");
      },
    );

    testBehaviour("--debug shows HTTP trace", async ({ run, projectRef }) => {
      const result = await run(["backups", "list", "--debug", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/HTTP.*GET:/);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["backups", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["backups", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run(["backups", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["backups", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["backups", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["backups", "list", "--project-ref", PROJECT_REF]);
    testParity(["backups", "list", "--project-ref", PROJECT_REF], { failureType: "NON_AUTH" });
  });

  describe("backups:restore", () => {
    testBehaviour.skipIf(isRecording)(
      "initiates PITR restore with -t timestamp",
      async ({ run, projectRef }) => {
        const result = await run([
          "backups",
          "restore",
          "-t",
          String(BACKUP_TIMESTAMP),
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
      },
    );

    testBehaviour("exits non-zero on 422 out-of-range timestamp", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 422,
          body: { message: "recovery time target is out of range" },
        }),
      });
      const result = await run(["backups", "restore", "-t", "0", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("out of range");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "backups",
        "restore",
        "-t",
        String(BACKUP_TIMESTAMP),
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run([
        "backups",
        "restore",
        "-t",
        String(BACKUP_TIMESTAMP),
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
        "backups",
        "restore",
        "-t",
        String(BACKUP_TIMESTAMP),
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
        "backups",
        "restore",
        "-t",
        String(BACKUP_TIMESTAMP),
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity([
      "backups",
      "restore",
      "-t",
      String(BACKUP_TIMESTAMP),
      "--project-ref",
      PROJECT_REF,
    ]);
    testParity(
      ["backups", "restore", "-t", String(BACKUP_TIMESTAMP), "--project-ref", PROJECT_REF],
      { failureType: "NON_AUTH" },
    );
  });
});

describe("snippets", () => {
  describe("snippets:list", () => {
    testBehaviour("renders snippet table with ID and NAME columns", async ({ run, projectRef }) => {
      const result = await run(["snippets", "list", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ID");
      expect(result.stdout).toContain("NAME");
    });

    testBehaviour(
      "returns snippet list as JSON with --output json",
      async ({ run, projectRef }) => {
        const result = await run([
          "snippets",
          "list",
          "--output",
          "json",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(Array.isArray(parsed.data)).toBe(true);
      },
    );

    testBehaviour("--debug shows HTTP trace", async ({ run, projectRef }) => {
      const result = await run(["snippets", "list", "--debug", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/HTTP.*GET:/);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["snippets", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["snippets", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run(["snippets", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["snippets", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["snippets", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["snippets", "list", "--project-ref", PROJECT_REF]);
    testParity(["snippets", "list", "--project-ref", PROJECT_REF], { failureType: "NON_AUTH" });
  });

  describe("snippets:download", () => {
    testBehaviour.skipIf(isRecording)(
      "prints SQL content to stdout",
      async ({ run, projectRef }) => {
        const result = await run(["snippets", "download", SNIPPET_ID, "--project-ref", projectRef]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toBe("");
      },
    );

    testBehaviour("exits non-zero on 404 snippet not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Snippet not found" } }),
      });
      const result = await run(["snippets", "download", SNIPPET_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not found");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["snippets", "download", SNIPPET_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["snippets", "download", SNIPPET_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["snippets", "download", SNIPPET_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["snippets", "download", SNIPPET_ID, "--project-ref", PROJECT_REF]);
    testParity(["snippets", "download", SNIPPET_ID, "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });
});
