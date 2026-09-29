import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";
import { gunzipSync } from "node:zlib";
import { runSupabaseEffect } from "../../../tests/helpers/cli.ts";

type CapturedEvent = {
  readonly event: unknown;
  readonly properties: unknown;
};

class TelemetryReceiverError extends Data.TaggedError("TelemetryReceiverError")<{
  readonly cause: unknown;
}> {}

describe("failed command telemetry", () => {
  // `branches list` needs a syntactically valid access token so the auth gate builds and the
  // failure happens during project-ref resolution instead of at the auth gate itself.
  it.live.each([
    {
      args: ["branches", "list"],
      command: "branches list",
      accessToken: "sbp_0000000000000000000000000000000000000000",
      expected: {
        error_kind: "user_actionable",
        error_category: "project_not_linked",
        error_fingerprint: "tag:ProjectRefNotLinkedError",
        has_suggestion: true,
        suggestion_type: "link_project",
        suggested_command: "supabase link",
      },
      rawErrors: ["Cannot find project ref. Have you run supabase link?"],
    },
    {
      args: [
        "db",
        "query",
        "--db-url",
        "postgres://postgres:postgres@127.0.0.1:1/postgres",
        "select 1",
      ],
      command: "db query",
      accessToken: "",
      expected: {
        error_kind: "user_actionable",
        error_category: "db_connection",
        error_fingerprint: "tag:DbConnectError",
        has_suggestion: true,
        suggestion_type: "update_config",
      },
      rawErrors: ["failed to connect", "127.0.0.1", "select 1"],
    },
  ])("emits sanitized metadata from the compiled CLI ($command)", (testCase) =>
    Effect.gen(function* () {
      const capturedEvents: CapturedEvent[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                return request.arrayBuffer().then((buffer) => {
                  const body = new Uint8Array(buffer);
                  const decoded =
                    request.headers.get("content-encoding") === "gzip" ? gunzipSync(body) : body;
                  const payload: unknown = JSON.parse(new TextDecoder().decode(decoded));
                  if (typeof payload === "object" && payload !== null) {
                    const batch = Reflect.get(payload, "batch");
                    if (Array.isArray(batch)) capturedEvents.push(...batch);
                  }
                  return Response.json({});
                });
              },
            }),
          catch: (cause) => new TelemetryReceiverError({ cause }),
        }),
        (running) => Effect.promise(() => running.stop(true)),
      );

      const result = yield* runSupabaseEffect(testCase.args, {
        env: {
          SUPABASE_ACCESS_TOKEN: testCase.accessToken,
          SUPABASE_TELEMETRY_DISABLED: "0",
          DO_NOT_TRACK: "0",
          SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_failure_metadata_e2e",
          SUPABASE_TELEMETRY_POSTHOG_HOST: server.url.origin,
        },
      });

      expect(result.exitCode).toBe(1);
      const event = capturedEvents.find((candidate) => candidate.event === "cli_command_executed");
      expect(event).toBeDefined();
      expect(event?.properties).toMatchObject({
        command: testCase.command,
        exit_code: 1,
        ...testCase.expected,
      });
      expect(event?.properties).not.toHaveProperty("workflow");
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(event);
      for (const rawError of testCase.rawErrors) expect(encoded).not.toContain(rawError);
    }),
  );
});
