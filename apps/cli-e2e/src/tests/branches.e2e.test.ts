import { afterEach, beforeEach, describe, expect, inject, test } from "vitest";
import {
  createHarness,
  exec,
  makeTempDir,
  runParity,
  type TempDir,
} from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, isRecording, PROJECT_REF, TARGET } from "./env.ts";

describe("branches", () => {
  const serverUrl = inject("replayServerUrl");
  let tempDir: TempDir;

  beforeEach(() => {
    tempDir = makeTempDir("cli-e2e-branches-");
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

  test("branches list renders fixture data in output", async () => {
    const result = await exec(makeHarness(), ["branches", "list", "--project-ref", PROJECT_REF]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("NAME");
    expect(result.stdout).toContain("STATUS");
  });

  test("branches list exits non-zero on 401", async () => {
    await fetch(`${serverUrl}/_ctrl/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "GET",
        path: `/v1/projects/${PROJECT_REF}/branches`,
        status: 401,
        body: { message: "Invalid token" },
      }),
    });

    try {
      const result = await exec(makeHarness(), ["branches", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
    } finally {
      await fetch(`${serverUrl}/_ctrl/overrides`, { method: "DELETE" });
    }
  });

  test.skipIf(isRecording)("branches list: ts-legacy stdout matches go", () =>
    runParity({ apiUrl: serverUrl, accessToken: ACCESS_TOKEN, cwd: tempDir.path }, [
      "branches",
      "list",
      "--project-ref",
      PROJECT_REF,
    ]),
  );
});
