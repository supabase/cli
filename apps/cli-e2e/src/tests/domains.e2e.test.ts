import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { REPLAY_PROJECT_REF } from "../server/placeholder.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context";
import { isRecording, PROJECT_REF } from "./env";

const CONFIGURED_CNAME = "www.urgsimurksi.xyz";

describe("domains", () => {
  describe.todo("domains:create — requires mocking of 1.1.1.1 for DNS queries");

  describe("domains:get", () => {
    testBehaviour("custom domain disabled", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 400,
            body: { message: "Please enable custom domains first" },
          });

          const result = yield* run(["domains", "get", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("no custom domain", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "get", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("pending verification", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "get", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain(
            "_acme-challenge.www.urgsimurksi.xyz TXT -> dx8wOwXMeAgc7uOQ3q0RlSQKvGl_HhcIsph_9PqwQYw",
          );
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("verification completed", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "get", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain(
            `www.urgsimurksi.xyz CNAME -> ${REPLAY_PROJECT_REF}.supabase.red`,
          );
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("domain activated", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "domains",
            "get",
            "--project-ref",
            PROJECT_REF,
            "--output",
            "json",
          ]);

          expect(result.exitCode).toBe(0);

          expect(yield* decodeJsonOutput(Schema.Unknown)(result.stdout)).toEqual({
            custom_hostname: "www.urgsimurksi.xyz",
            data: {
              errors: [],
              messages: [],
              result: {
                custom_origin_server: `${REPLAY_PROJECT_REF}.supabase.red`,
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
        }),
        signal,
      ),
    );

    testBehaviour("exists non-zero on 403", ({ apiUrl, run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Unauthorized" },
          });

          const result = yield* run(["domains", "get", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("403");
        }),
        signal,
      ),
    );

    testBehaviour("exists non-zero on 401", ({ apiUrl, run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Unauthorized" },
          });

          const result = yield* run(["domains", "get", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("401");
        }),
        signal,
      ),
    );

    testBehaviour("exists non-zero on 429", ({ apiUrl, run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 429,
            body: { message: "Too Many Requests" },
          });

          const result = yield* run(["domains", "get", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("429");
        }),
        signal,
      ),
    );

    testBehaviour("exists non-zero on 500", ({ apiUrl, run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });

          const result = yield* run(["domains", "get", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("500");
        }),
        signal,
      ),
    );

    testBehaviour("exists non-zero on 502", ({ apiUrl, run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 502,
            body: { message: "Bad Gateway" },
          });

          const result = yield* run(["domains", "get", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("502");
        }),
        signal,
      ),
    );
  });

  describe("domains:reverify", () => {
    testBehaviour("custom domain disabled", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "reverify", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("no custom domain", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "reverify", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("pending verification", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "reverify", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain(
            "_acme-challenge.www.urgsimurksi.xyz TXT -> dx8wOwXMeAgc7uOQ3q0RlSQKvGl_HhcIsph_9PqwQYw",
          );
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("verification completed", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "reverify", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );
  });
  describe("domains:activate", () => {
    testBehaviour("custom domain disabled", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "activate", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("no custom domain", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "activate", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("pending verification", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "activate", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("pending verification in debug mode", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "domains",
            "activate",
            "--project-ref",
            PROJECT_REF,
            "--debug",
          ]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toMatch(/HTTP.*POST:/);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("verification completed", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "activate", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain(`completed`);
          expect(result.stderr).toContain(`at ${CONFIGURED_CNAME}`);
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("domain activated", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "activate", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );
  });

  describe("domains:delete", () => {
    testBehaviour("custom domain disabled", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "delete", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("no custom domain", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "delete", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("pending verification", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["domains", "delete", "--project-ref", PROJECT_REF]);

          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );
  });
});
