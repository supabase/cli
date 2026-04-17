import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

describe("secrets", () => {
  testBehaviour("renders fixture data in output", async ({ run }) => {
    const result = await run(["secrets", "list", "--project-ref", PROJECT_REF]);
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
    const result = await run(["secrets", "list", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
  });

  testParity(["secrets", "list", "--project-ref", PROJECT_REF]);
  testParity(["secrets", "list", "--project-ref", PROJECT_REF], { failureType: "NON_AUTH" });
});
