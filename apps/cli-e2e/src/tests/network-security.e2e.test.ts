import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

describe("network-bans", () => {
  describe("network-bans:get", () => {
    testBehaviour("renders fixture data in output", async ({ run, projectRef }) => {
      const result = await run([
        "network-bans",
        "get",
        "--experimental",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("returns json output with --output json", async ({ run, projectRef }) => {
      const result = await run([
        "network-bans",
        "get",
        "--experimental",
        "--output",
        "json",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("includes debug output with --debug", async ({ run, projectRef }) => {
      const result = await run([
        "network-bans",
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
        "network-bans",
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
        "network-bans",
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
        "network-bans",
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
        "network-bans",
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
        "network-bans",
        "get",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["network-bans", "get", "--experimental", "--project-ref", PROJECT_REF]);
    testParity(["network-bans", "get", "--experimental", "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("network-bans:remove", () => {
    testBehaviour("removes IP from ban list", async ({ run, projectRef }) => {
      const result = await run([
        "network-bans",
        "remove",
        "--experimental",
        "--db-unban-ip",
        "1.2.3.4",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("removes multiple IPs from ban list", async ({ run, projectRef }) => {
      const result = await run([
        "network-bans",
        "remove",
        "--experimental",
        "--db-unban-ip",
        "1.2.3.4",
        "--db-unban-ip",
        "5.6.7.8",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("exits non-zero with invalid IP address", async ({ run }) => {
      const result = await run([
        "network-bans",
        "remove",
        "--experimental",
        "--db-unban-ip",
        "invalid-ip",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("invalid IP address");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "network-bans",
        "remove",
        "--experimental",
        "--db-unban-ip",
        "1.2.3.4",
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
        "network-bans",
        "remove",
        "--experimental",
        "--db-unban-ip",
        "1.2.3.4",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testParity([
      "network-bans",
      "remove",
      "--experimental",
      "--db-unban-ip",
      "1.2.3.4",
      "--project-ref",
      PROJECT_REF,
    ]);
    testParity(
      [
        "network-bans",
        "remove",
        "--experimental",
        "--db-unban-ip",
        "1.2.3.4",
        "--project-ref",
        PROJECT_REF,
      ],
      { failureType: "NON_AUTH" },
    );
  });
});

describe("network-restrictions", () => {
  describe("network-restrictions:get", () => {
    testBehaviour("renders fixture data in output", async ({ run, projectRef }) => {
      const result = await run([
        "network-restrictions",
        "get",
        "--experimental",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("returns json output with --output json", async ({ run, projectRef }) => {
      const result = await run([
        "network-restrictions",
        "get",
        "--experimental",
        "--output",
        "json",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "network-restrictions",
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
        "network-restrictions",
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
        "network-restrictions",
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
        "network-restrictions",
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
        "network-restrictions",
        "get",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["network-restrictions", "get", "--experimental", "--project-ref", PROJECT_REF]);
    testParity(["network-restrictions", "get", "--experimental", "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("network-restrictions:update", () => {
    testBehaviour("sets CIDR allowlist", async ({ run, projectRef }) => {
      const result = await run([
        "network-restrictions",
        "update",
        "--experimental",
        "--db-allow-cidr",
        "0.0.0.0/0",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("appends to existing restrictions", async ({ run, projectRef }) => {
      const result = await run([
        "network-restrictions",
        "update",
        "--experimental",
        "--append",
        "--db-allow-cidr",
        "8.8.8.0/24",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("bypasses CIDR validation checks", async ({ run, projectRef }) => {
      const result = await run([
        "network-restrictions",
        "update",
        "--experimental",
        "--bypass-cidr-checks",
        "--db-allow-cidr",
        "0.0.0.0/0",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("exits non-zero with invalid CIDR format", async ({ run }) => {
      const result = await run([
        "network-restrictions",
        "update",
        "--experimental",
        "--db-allow-cidr",
        "not-a-cidr",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("failed to parse IP");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "network-restrictions",
        "update",
        "--experimental",
        "--db-allow-cidr",
        "0.0.0.0/0",
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
        "network-restrictions",
        "update",
        "--experimental",
        "--db-allow-cidr",
        "0.0.0.0/0",
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
        "network-restrictions",
        "update",
        "--experimental",
        "--db-allow-cidr",
        "0.0.0.0/0",
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
        "network-restrictions",
        "update",
        "--experimental",
        "--db-allow-cidr",
        "0.0.0.0/0",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity([
      "network-restrictions",
      "update",
      "--experimental",
      "--db-allow-cidr",
      "0.0.0.0/0",
      "--project-ref",
      PROJECT_REF,
    ]);
    testParity(
      [
        "network-restrictions",
        "update",
        "--experimental",
        "--db-allow-cidr",
        "0.0.0.0/0",
        "--project-ref",
        PROJECT_REF,
      ],
      { failureType: "NON_AUTH" },
    );
  });
});

describe("ssl-enforcement", () => {
  describe("ssl-enforcement:get", () => {
    testBehaviour("renders fixture data in output", async ({ run, projectRef }) => {
      const result = await run([
        "ssl-enforcement",
        "get",
        "--experimental",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("returns json output with --output json", async ({ run, projectRef }) => {
      const result = await run([
        "ssl-enforcement",
        "get",
        "--experimental",
        "--output",
        "json",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
        "ssl-enforcement",
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
        "ssl-enforcement",
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
        "ssl-enforcement",
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
        "ssl-enforcement",
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
        "ssl-enforcement",
        "get",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["ssl-enforcement", "get", "--experimental", "--project-ref", PROJECT_REF]);
    testParity(["ssl-enforcement", "get", "--experimental", "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("ssl-enforcement:update", () => {
    testBehaviour("enables SSL enforcement", async ({ run, projectRef }) => {
      const result = await run([
        "ssl-enforcement",
        "update",
        "--experimental",
        "--enable-db-ssl-enforcement",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("disables SSL enforcement", async ({ run, projectRef }) => {
      const result = await run([
        "ssl-enforcement",
        "update",
        "--experimental",
        "--disable-db-ssl-enforcement",
        "--project-ref",
        projectRef,
      ]);
      expect(result.exitCode).toBe(0);
    });

    testBehaviour("exits non-zero with mutually exclusive flags", async ({ run }) => {
      const result = await run([
        "ssl-enforcement",
        "update",
        "--experimental",
        "--enable-db-ssl-enforcement",
        "--disable-db-ssl-enforcement",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
    });

    testBehaviour("exits non-zero with no flags provided", async ({ run }) => {
      const result = await run([
        "ssl-enforcement",
        "update",
        "--experimental",
        "--project-ref",
        PROJECT_REF,
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
        "ssl-enforcement",
        "update",
        "--experimental",
        "--enable-db-ssl-enforcement",
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
        "ssl-enforcement",
        "update",
        "--experimental",
        "--enable-db-ssl-enforcement",
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
        "ssl-enforcement",
        "update",
        "--experimental",
        "--enable-db-ssl-enforcement",
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
        "ssl-enforcement",
        "update",
        "--experimental",
        "--enable-db-ssl-enforcement",
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
        "ssl-enforcement",
        "update",
        "--experimental",
        "--enable-db-ssl-enforcement",
        "--project-ref",
        PROJECT_REF,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity([
      "ssl-enforcement",
      "update",
      "--experimental",
      "--enable-db-ssl-enforcement",
      "--project-ref",
      PROJECT_REF,
    ]);
    testParity(
      [
        "ssl-enforcement",
        "update",
        "--experimental",
        "--enable-db-ssl-enforcement",
        "--project-ref",
        PROJECT_REF,
      ],
      { failureType: "NON_AUTH" },
    );
  });
});
