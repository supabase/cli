import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

type CapturedEvent = {
  readonly event: unknown;
  readonly properties: unknown;
};

describe("failed command telemetry", () => {
  let server: Server;
  let host: string;
  const capturedEvents: CapturedEvent[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const decoded = request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body;
        const payload: unknown = JSON.parse(decoded.toString());
        if (typeof payload === "object" && payload !== null) {
          const batch = Reflect.get(payload, "batch");
          if (Array.isArray(batch)) capturedEvents.push(...batch);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to allocate a telemetry receiver port");
    }
    host = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  beforeEach(() => {
    capturedEvents.length = 0;
  });

  // Both cases exercise the legacy shell (the only remaining shell). The
  // `branches list` case needs a syntactically valid access token so the
  // Management API auth gate builds successfully and the failure happens
  // in-handler, during project-ref resolution, rather than at the auth gate
  // (which deliberately keeps its existing no-event behavior).
  test.each([
    {
      args: ["branches", "list"],
      command: "branches list",
      accessToken: "sbp_0000000000000000000000000000000000000000",
      expected: {
        error_kind: "user_actionable",
        error_category: "project_not_linked",
        error_fingerprint: "tag:LegacyProjectNotLinkedError",
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
        error_fingerprint: "tag:LegacyDbConnectError",
        has_suggestion: true,
        suggestion_type: "update_config",
      },
      rawErrors: ["failed to connect", "127.0.0.1", "select 1"],
    },
  ])("emits sanitized metadata from the compiled legacy shell ($command)", async (testCase) => {
    const result = await runSupabase(testCase.args, {
      entrypoint: "legacy",
      env: {
        SUPABASE_ACCESS_TOKEN: testCase.accessToken,
        SUPABASE_TELEMETRY_DISABLED: "0",
        DO_NOT_TRACK: "0",
        SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_failure_metadata_e2e",
        SUPABASE_TELEMETRY_POSTHOG_HOST: host,
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
    const encoded = JSON.stringify(event);
    for (const rawError of testCase.rawErrors) expect(encoded).not.toContain(rawError);
  });
});
