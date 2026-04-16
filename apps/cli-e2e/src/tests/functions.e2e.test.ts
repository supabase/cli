import { afterEach, beforeEach, describe, expect, inject, test } from "vitest";
import {
  createHarness,
  exec,
  makeTempDir,
  runParity,
  type TempDir,
} from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, isRecording, PROJECT_REF, TARGET } from "./env.ts";

describe("functions", () => {
  const serverUrl = inject("replayServerUrl");
  let tempDir: TempDir;

  beforeEach(() => {
    tempDir = makeTempDir("cli-e2e-functions-");
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

  describe("function:list", () => {
    test("functions list renders fixture data in output", async () => {
      const result = await exec(makeHarness(), ["functions", "list", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("NAME");
      expect(result.stdout).toContain("STATUS");
    });

    test("functions list exits non-zero on 401", async () => {
      await fetch(`${serverUrl}/_ctrl/error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "GET",
          path: `/v1/projects/${PROJECT_REF}/functions`,
          status: 401,
          body: { message: "Invalid token" },
        }),
      });

      try {
        const result = await exec(makeHarness(), [
          "functions",
          "list",
          "--project-ref",
          PROJECT_REF,
        ]);
        expect(result.exitCode).not.toBe(0);
      } finally {
        await fetch(`${serverUrl}/_ctrl/overrides`, { method: "DELETE" });
      }
    });

    test.skipIf(isRecording)("functions list: ts-legacy stdout matches go", () =>
      runParity({ apiUrl: serverUrl, accessToken: ACCESS_TOKEN, cwd: tempDir.path }, [
        "functions",
        "list",
        "--project-ref",
        PROJECT_REF,
      ]),
    );
  });

  describe("functions:new", () => {
    test("functions new should successfully create a new function", async () => {
      const result = await exec(makeHarness(), ["functions", "new", "testFunction"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created new Function at supabase/functions/testFunction");
    });

    test.skipIf(isRecording)("functions new: ts-legacy stdout matches go", () =>
      runParity({ apiUrl: serverUrl, accessToken: ACCESS_TOKEN, cwd: tempDir.path }, [
        "functions",
        "new",
        "testFunction",
      ]),
    );
  });
});
