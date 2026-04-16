import { afterEach, beforeEach, describe, expect, inject, test } from "vitest";
import {
  createHarness,
  exec,
  makeTempDir,
  runParity,
  type TempDir,
} from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, isRecording, PROJECT_REF, TARGET } from "./env.ts";

describe("projects", () => {
  const serverUrl = inject("replayServerUrl");
  let tempDir: TempDir;

  beforeEach(() => {
    tempDir = makeTempDir("cli-e2e-projects-");
  });

  afterEach(async () => {
    tempDir[Symbol.dispose]();
    // Reset fixture sequence counters and request log between tests
    await fetch(`${serverUrl}/_ctrl/requests`, { method: "DELETE" });
  });

  function makeHarness() {
    return createHarness(TARGET, {
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: tempDir.path,
    });
  }

  describe("projects:list", () => {
    test("projects list renders fixture data in output", async () => {
      const result = await exec(makeHarness(), ["projects", "list"]);

      expect(result.exitCode).toBe(0);
      // The fixture response contains projects with these placeholder values.
      // Their presence in stdout confirms the CLI received and rendered the
      // fixture response rather than just exiting cleanly.
      expect(result.stdout).toContain("<PROJECT_REF_1>");
      expect(result.stdout).toContain("REFERENCE ID");
    });

    test("projects list exits non-zero on 401", async () => {
      await fetch(`${serverUrl}/_ctrl/error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "GET",
          path: "/v1/projects",
          status: 401,
          body: { message: "Invalid token" },
        }),
      });

      try {
        const result = await exec(makeHarness(), ["projects", "list"]);
        expect(result.exitCode).not.toBe(0);
      } finally {
        await fetch(`${serverUrl}/_ctrl/overrides`, { method: "DELETE" });
      }
    });

    // Parity test: always runs both go and ts-legacy explicitly and asserts that
    // their stdout is identical. This is the core parity guarantee — if ts-legacy
    // is correctly ported, its table output must match the Go CLI byte-for-byte.
    // Skipped in record mode since only the go harness is used for recording.
    test.skipIf(isRecording)("projects list: ts-legacy stdout matches go", () =>
      runParity({ apiUrl: serverUrl, accessToken: ACCESS_TOKEN, cwd: tempDir.path }, [
        "projects",
        "list",
      ]),
    );
  });
  describe("projects:api-keys", () => {
    test("projects api-keys shows default and anon keys", async () => {
      const result = await exec(makeHarness(), [
        "projects",
        "api-keys",
        "--project-ref",
        PROJECT_REF,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("NAME");
      expect(result.stdout).toContain("KEY VALUE");
      expect(result.stdout).toContain("anon");
      expect(result.stdout).toContain("default");
    });

    test.skipIf(isRecording)("projects api-keys: ts-legacy stdout matches go", () =>
      runParity({ apiUrl: serverUrl, accessToken: ACCESS_TOKEN, cwd: tempDir.path }, [
        "projects",
        "api-keys",
        "--project-ref",
        PROJECT_REF,
      ]),
    );
  });
});
