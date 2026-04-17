import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

describe("projects", () => {
  describe("projects:list", () => {
    testBehaviour("renders project list", async ({ run }) => {
      const result = await run(["projects", "list"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("<PROJECT_REF>");
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

    testParity(["projects", "list"]);
    testParity(["projects", "list"], { failureType: "NON_AUTH" });
  });

  describe("projects:api-keys", () => {
    testBehaviour("shows default and anon keys", async ({ run }) => {
      const result = await run(["projects", "api-keys", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("NAME");
      expect(result.stdout).toContain("KEY VALUE");
      expect(result.stdout).toContain("anon");
      expect(result.stdout).toContain("default");
    });

    testParity(["projects", "api-keys", "--project-ref", PROJECT_REF]);
  });
});
