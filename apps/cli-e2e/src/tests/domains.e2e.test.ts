import { describe, expect } from "vitest";
import { testBehaviour, testParity } from "./test-context";
import { isRecording, PROJECT_REF } from "./env";

const CONFIGURED_CNAME = "www.urgsimurksi.xyz";

describe("domains", () => {
  describe.todo("domains:create — requires mocking of 1.1.1.1 for DNS queries");

  describe("domains:get", () => {
    testBehaviour("custom domain disabled", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 400,
          body: { message: "Please enable custom domains first" },
        }),
      });

      const result = await run(["domains", "get", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });

    testBehaviour.skipIf(isRecording)("no custom domain", async ({ run }) => {
      const result = await run(["domains", "get", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });

    testBehaviour.skipIf(isRecording)("pending verification", async ({ run }) => {
      const result = await run(["domains", "get", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        "_acme-challenge.www.urgsimurksi.xyz TXT -> dx8wOwXMeAgc7uOQ3q0RlSQKvGl_HhcIsph_9PqwQYw",
      );
    });

    testBehaviour.skipIf(isRecording)("verification completed", async ({ run }) => {
      const result = await run(["domains", "get", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("www.urgsimurksi.xyz CNAME -> __PROJECT_REF__.supabase.red");
    });

    testBehaviour.skipIf(isRecording)("domain activated", async ({ run }) => {
      const result = await run([
        "domains",
        "get",
        "--project-ref",
        PROJECT_REF,
        "--output",
        "json",
      ]);

      expect(result.exitCode).toBe(0);

      expect(JSON.parse(result.stdout)).toEqual({
        custom_hostname: "www.urgsimurksi.xyz",
        data: {
          errors: [],
          messages: [],
          result: {
            custom_origin_server: "__PROJECT_REF__.supabase.red",
            hostname: "www.urgsimurksi.xyz",
            id: "00000000-0000-0000-0000-000000000000",
            ownership_verification: {
              name: "",
              type: "",
              value: "",
            },
            ssl: {
              status: "active",
              validation_records: [],
            },
            status: "active",
          },
          success: true,
        },
        status: "5_services_reconfigured",
      });
    });

    testBehaviour("exists non-zero on 403", async ({ apiUrl, run }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 403,
          body: { message: "Unauthorized" },
        }),
      });

      const result = await run(["domains", "get", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("403");
    });

    testBehaviour("exists non-zero on 401", async ({ apiUrl, run }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 401,
          body: { message: "Unauthorized" },
        }),
      });

      const result = await run(["domains", "get", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("401");
    });

    testBehaviour("exists non-zero on 429", async ({ apiUrl, run }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 429,
          body: { message: "Too Many Requests" },
        }),
      });

      const result = await run(["domains", "get", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("429");
    });

    testBehaviour("exists non-zero on 500", async ({ apiUrl, run }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 500,
          body: { message: "Internal Server Error" },
        }),
      });

      const result = await run(["domains", "get", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("500");
    });

    testBehaviour("exists non-zero on 502", async ({ apiUrl, run }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 502,
          body: { message: "Bad Gateway" },
        }),
      });

      const result = await run(["domains", "get", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("502");
    });

    testParity(["domains", "get", "--project-ref", PROJECT_REF, "--output", "json"]);
  });

  describe("domains:reverify", () => {
    testParity(["domains", "reverify", "--project-ref", PROJECT_REF]);

    testBehaviour("custom domain disabled", async ({ run }) => {
      const result = await run(["domains", "reverify", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });

    testBehaviour.skipIf(isRecording)("no custom domain", async ({ run }) => {
      const result = await run(["domains", "reverify", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });

    testBehaviour.skipIf(isRecording)("pending verification", async ({ run }) => {
      const result = await run(["domains", "reverify", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        "_acme-challenge.www.urgsimurksi.xyz TXT -> dx8wOwXMeAgc7uOQ3q0RlSQKvGl_HhcIsph_9PqwQYw",
      );
    });

    testBehaviour.skipIf(isRecording)("verification completed", async ({ run }) => {
      const result = await run(["domains", "reverify", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });
  });
  describe("domains:activate", () => {
    testParity(["domains", "activate", "--project-ref", PROJECT_REF]);

    testBehaviour("custom domain disabled", async ({ run }) => {
      const result = await run(["domains", "activate", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });

    testBehaviour.skipIf(isRecording)("no custom domain", async ({ run }) => {
      const result = await run(["domains", "activate", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });

    testBehaviour.skipIf(isRecording)("pending verification", async ({ run }) => {
      const result = await run(["domains", "activate", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });

    testBehaviour.skipIf(isRecording)("pending verification in debug mode", async ({ run }) => {
      const result = await run(["domains", "activate", "--project-ref", PROJECT_REF, "--debug"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/HTTP.*POST:/);
      expect(result.stderr).toContain("400");
    });

    testBehaviour.skipIf(isRecording)("verification completed", async ({ run }) => {
      const result = await run(["domains", "activate", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(`completed`);
      expect(result.stderr).toContain(`at ${CONFIGURED_CNAME}`);
    });

    testBehaviour.skipIf(isRecording)("domain activated", async ({ run }) => {
      const result = await run(["domains", "activate", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });
  });

  describe("domains:delete", () => {
    testParity(["domains", "delete", "--project-ref", PROJECT_REF]);

    testBehaviour("custom domain disabled", async ({ run }) => {
      const result = await run(["domains", "delete", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });

    testBehaviour.skipIf(isRecording)("no custom domain", async ({ run }) => {
      const result = await run(["domains", "delete", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("400");
    });

    testBehaviour.skipIf(isRecording)("pending verification", async ({ run }) => {
      const result = await run(["domains", "delete", "--project-ref", PROJECT_REF]);

      expect(result.exitCode).toBe(0);
    });
  });
});
