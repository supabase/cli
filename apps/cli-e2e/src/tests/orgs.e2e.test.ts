import { describe, expect } from "vitest";
import { testBehaviour, testParity } from "./test-context.ts";

describe("orgs", () => {
  testBehaviour("renders org data", async ({ run }) => {
    const result = await run(["orgs", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[a-z]{20}|<PROJECT_REF>/);
    expect(result.stdout).toContain("ID");
  });

  testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
    });
    const result = await run(["orgs", "list"]);
    expect(result.exitCode).not.toBe(0);
  });

  testParity(["orgs", "list"]);
  testParity(["orgs", "list"], { failureType: "NON_AUTH" });
});
