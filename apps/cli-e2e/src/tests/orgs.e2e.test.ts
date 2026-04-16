import { afterEach, beforeEach, describe, expect, inject, test } from "vitest";
import {
  createHarness,
  exec,
  makeTempDir,
  runParity,
  type TempDir,
} from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, isRecording, TARGET } from "./env.ts";

describe("orgs", () => {
  const serverUrl = inject("replayServerUrl");
  let tempDir: TempDir;

  beforeEach(() => {
    tempDir = makeTempDir("cli-e2e-orgs-");
  });

  afterEach(async () => {
    tempDir[Symbol.dispose]();
    await fetch(`${serverUrl}/_ctrl/requests`, { method: "DELETE" });
  });

  function makeHarness() {
    return createHarness(TARGET, {
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: tempDir.path,
    });
  }

  test("orgs list renders org data", async () => {
    const result = await exec(makeHarness(), ["orgs", "list"]);

    expect(result.exitCode).toBe(0);
    // Org IDs are 20-char alpha strings — they become <PROJECT_REF_N> in the
    // fixture and must appear in the rendered table.
    expect(result.stdout).toContain("<PROJECT_REF_1>");
    expect(result.stdout).toContain("ID");
  });

  test("orgs list exits non-zero on 401", async () => {
    await fetch(`${serverUrl}/_ctrl/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "GET",
        path: "/v1/organizations",
        status: 401,
        body: { message: "Invalid token" },
      }),
    });

    try {
      const result = await exec(makeHarness(), ["orgs", "list"]);
      expect(result.exitCode).not.toBe(0);
    } finally {
      await fetch(`${serverUrl}/_ctrl/overrides`, { method: "DELETE" });
    }
  });

  test.skipIf(isRecording)("orgs list: ts-legacy stdout matches go", () =>
    runParity({ apiUrl: serverUrl, accessToken: ACCESS_TOKEN, cwd: tempDir.path }, [
      "orgs",
      "list",
    ]),
  );
});
