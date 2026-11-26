import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { gunzipSync } from "node:zlib";
import { makeTempHome, runSupabaseEffect } from "../../../tests/helpers/cli.ts";

describe("issues telemetry from the compiled CLI", () => {
  it.live.each([
    {
      name: "fail-on",
      unavailable: false,
      failOn: "critical",
      fingerprint: "tag:IssuesFailOnError",
      kind: "user_actionable",
      category: "invalid_config",
    },
    {
      name: "unavailable coverage",
      unavailable: true,
      failOn: "none",
      fingerprint: "tag:IssuesChecksUnavailableError",
      kind: "external_service",
      category: "api_status",
    },
    {
      name: "unavailable coverage and fail-on",
      unavailable: true,
      failOn: "critical",
      fingerprint: "tag:IssuesChecksUnavailableError",
      kind: "external_service",
      category: "api_status",
    },
  ])("preserves machine output and records $name", (testCase) =>
    Effect.gen(function* () {
      const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              const path = new URL(request.url).pathname;
              if (path.endsWith("/advisors/security"))
                return Response.json({
                  lints: [
                    {
                      name: "rls_disabled_in_public",
                      title: "RLS disabled in public",
                      level: "ERROR",
                      facing: "EXTERNAL",
                      categories: ["SECURITY"],
                      description: "Detects tables without RLS.",
                      detail: "Table public.private_fixture has RLS disabled",
                      remediation: "https://supabase.com/docs",
                      metadata: { schema: "public", name: "private_fixture", type: "table" },
                      cache_key: "private_fixture_cache_key",
                    },
                  ],
                });
              if (path.endsWith("/advisors/performance")) return Response.json({ lints: [] });
              if (path.endsWith("/advisors/run"))
                return testCase.unavailable
                  ? Response.json({ message: "private upstream response" }, { status: 503 })
                  : Response.json({
                      data: { type: "project_advisors", attributes: { lints: [] } },
                    });
              if (path.startsWith("/v1/projects/"))
                return Response.json({
                  id: "abcdefghijklmnopqrst",
                  ref: "abcdefghijklmnopqrst",
                  name: "fixture",
                  organization_id: "org-123",
                  organization_slug: "fixture-org",
                  region: "us-east-1",
                  created_at: "2026-05-27T01:02:03Z",
                  status: "ACTIVE_HEALTHY",
                  database: {
                    host: "db.fixture.supabase.co",
                    version: "15.1",
                    postgres_engine: "15",
                    release_channel: "ga",
                  },
                });
              return request.arrayBuffer().then((buffer) => {
                const body = new Uint8Array(buffer);
                const decoded =
                  request.headers.get("content-encoding") === "gzip" ? gunzipSync(body) : body;
                const payload: unknown = JSON.parse(new TextDecoder().decode(decoded));
                if (typeof payload === "object" && payload !== null) {
                  const batch: unknown = Reflect.get(payload, "batch");
                  if (Array.isArray(batch)) events.push(...batch);
                }
                return Response.json({});
              });
            },
          }),
        ),
        (running) => Effect.promise(() => running.stop(true)),
      );
      const home = yield* makeTempHome;
      const profilePath = `${home.dir}/issues-profile.yaml`;
      yield* (yield* FileSystem.FileSystem).writeFileString(
        profilePath,
        [
          "name: issues-e2e",
          `api_url: "${server.url.origin}"`,
          `dashboard_url: "${server.url.origin}"`,
          'project_host: "example.invalid"',
          "",
        ].join("\n"),
      );
      const result = yield* runSupabaseEffect(
        [
          "issues",
          "--remote=abcdefghijklmnopqrst",
          "--output-format",
          "json",
          "--fail-on",
          testCase.failOn,
        ],
        {
          cwd: home.dir,
          home: home.dir,
          env: {
            SUPABASE_ACCESS_TOKEN: "sbp_0000000000000000000000000000000000000000",
            SUPABASE_PROFILE: profilePath,
            SUPABASE_WORKDIR: home.dir,
            SUPABASE_API_MAX_RETRIES: "0",
            SUPABASE_TELEMETRY_DISABLED: "0",
            DO_NOT_TRACK: "0",
            SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_issues_metadata_e2e",
            SUPABASE_TELEMETRY_POSTHOG_HOST: server.url.origin,
          },
        },
      );
      expect(result.stderr).not.toContain("Error:");
      expect(result.exitCode).toBe(1);
      const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        result.stdout,
      );
      expect(payload).toMatchObject({
        message: "issues",
        issues: [expect.objectContaining({ id: "rls_disabled_in_public", severity: "critical" })],
        checks: [
          { type: "security", status: "complete" },
          { type: "performance", status: "complete" },
          testCase.unavailable
            ? { type: "health", status: "unavailable", reason: expect.any(String) }
            : { type: "health", status: "complete" },
        ],
      });
      const event = events.find((candidate) => candidate.event === "cli_command_executed");
      expect(event?.properties).toMatchObject({
        command: "issues",
        exit_code: 1,
        error_fingerprint: testCase.fingerprint,
        error_kind: testCase.kind,
        error_category: testCase.category,
      });
      expect(event?.properties).not.toHaveProperty("processControlledFailure");
      const encodedEvent = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(event);
      expect(encodedEvent).not.toContain("private_fixture");
      expect(encodedEvent).not.toContain("private upstream response");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
