import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

describe("functions", () => {
  describe("functions:list", () => {
    testBehaviour("renders fixture data in output", async ({ run }) => {
      const result = await run(["functions", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("NAME");
      expect(result.stdout).toContain("STATUS");
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

    testParity(["functions", "list", "--project-ref", PROJECT_REF]);
    testParity(["functions", "list", "--project-ref", PROJECT_REF], { failureType: "NON_AUTH" });
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
