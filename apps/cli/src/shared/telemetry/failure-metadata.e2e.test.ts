import { Effect, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

type CapturedEvent = {
  readonly event: unknown;
  readonly properties: unknown;
};

describe("failed command telemetry", () => {
  let server: { readonly port: number; readonly stop: () => Promise<void> };
  let host: string;
  const capturedEvents: CapturedEvent[] = [];

  beforeAll(() => {
    const runningServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const body = yield* Effect.tryPromise(() => request.arrayBuffer());
            const decoded =
              request.headers.get("content-encoding") === "gzip"
                ? yield* Effect.tryPromise(() =>
                    new Response(
                      new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip")),
                    ).text(),
                  )
                : new TextDecoder().decode(body);
            const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
              decoded,
            );
            if (typeof payload === "object" && payload !== null) {
              const batch = Reflect.get(payload, "batch");
              if (Array.isArray(batch)) capturedEvents.push(...batch);
            }
            return new Response("{}", { headers: { "content-type": "application/json" } });
          }),
        ),
    });
    const { port } = runningServer;
    if (port === undefined) throw new Error("Failed to allocate a telemetry receiver port");
    server = { port, stop: () => runningServer.stop() };
    host = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.stop());

  beforeEach(() => {
    capturedEvents.length = 0;
  });

  // Legacy auth-gate failures abort during runtime-layer construction, before
  // the instrumented handler runs, and deliberately keep their existing
  // no-event behavior — so the legacy case exercises an in-handler failure.
  test.each([
    {
      entrypoint: "next" as const,
      args: ["branches", "list"],
      command: "branches list",
      expected: {
        error_kind: "user_actionable",
        error_category: "project_not_linked",
        error_fingerprint: "tag:ProjectNotLinkedError",
        has_suggestion: true,
        suggestion_type: "link_project",
        suggested_command: "supabase link",
      },
      rawErrors: ["No project is linked in this directory."],
    },
    {
      entrypoint: "legacy" as const,
      args: [
        "db",
        "query",
        "--db-url",
        "postgres://postgres:postgres@127.0.0.1:1/postgres",
        "select 1",
      ],
      command: "db query",
      expected: {
        error_kind: "user_actionable",
        error_category: "db_connection",
        error_fingerprint: "tag:LegacyDbConnectError",
        has_suggestion: true,
        suggestion_type: "update_config",
      },
      rawErrors: ["failed to connect", "127.0.0.1", "select 1"],
    },
  ])("emits sanitized metadata from the compiled $entrypoint shell", (testCase) =>
    runSupabase(testCase.args, {
      entrypoint: testCase.entrypoint,
      env: {
        SUPABASE_ACCESS_TOKEN: "",
        SUPABASE_TELEMETRY_DISABLED: "0",
        DO_NOT_TRACK: "0",
        SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_failure_metadata_e2e",
        SUPABASE_TELEMETRY_POSTHOG_HOST: host,
      },
    }).then((result) => {
      expect(result.exitCode).toBe(1);
      const event = capturedEvents.find((candidate) => candidate.event === "cli_command_executed");
      expect(event).toBeDefined();
      expect(event?.properties).toMatchObject({
        command: testCase.command,
        exit_code: 1,
        ...testCase.expected,
      });
      expect(event?.properties).not.toHaveProperty("workflow");
      const encoded = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(event);
      for (const rawError of testCase.rawErrors) expect(encoded).not.toContain(rawError);
    }),
  );
});
