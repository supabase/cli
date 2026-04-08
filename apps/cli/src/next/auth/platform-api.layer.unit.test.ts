import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted, Stdio } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { CliConfig } from "../config/cli-config.service.ts";
import { CommandRuntime } from "../../shared/runtime/command-runtime.service.ts";
import { CurrentAnalyticsContext } from "../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { withCommandInstrumentation } from "../../shared/telemetry/command-instrumentation.ts";
import { Credentials } from "./credentials.service.ts";
import { PlatformApi } from "./platform-api.service.ts";
import { makePlatformApiServices } from "./platform-api.layer.ts";

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

function jsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
      },
    }),
  );
}

function cliConfigLayer(token = Option.none<Redacted.Redacted<string>>()) {
  return Layer.succeed(
    CliConfig,
    CliConfig.of({
      apiUrl: "https://api.supabase.com",
      dashboardUrl: "https://supabase.com/dashboard",
      projectHost: "supabase.co",
      telemetryPosthogHost: "https://us.i.posthog.com",
      telemetryPosthogKey: "phc_test_key",
      accessToken: token,
      noKeyring: Option.none(),
      supabaseHome: "/tmp/supabase-cli-test-home",
      debug: Option.none(),
      telemetryDebug: Option.none(),
      telemetryDisabled: Option.none(),
      doNotTrack: Option.none(),
    }),
  );
}

function credentialsLayer(token?: string) {
  return Layer.succeed(
    Credentials,
    Credentials.of({
      getAccessToken: Effect.succeed(
        token === undefined ? Option.none() : Option.some(Redacted.make(token)),
      ),
      saveAccessToken: () => Effect.void,
      deleteAccessToken: Effect.succeed(false),
    }),
  );
}

function commandRuntimeLayer(command: string, commandRunId: string) {
  return Layer.succeed(
    CommandRuntime,
    CommandRuntime.of({
      commandPath: command.split(" "),
      commandRunId,
    }),
  );
}

function mockContextualAnalytics() {
  const captured: Array<{
    event: string;
    properties: Record<string, unknown>;
  }> = [];

  const layer = Layer.succeed(
    Analytics,
    Analytics.of({
      capture: (event: string, properties: Record<string, unknown> = {}) =>
        Effect.gen(function* () {
          const context = yield* CurrentAnalyticsContext;
          captured.push({
            event,
            properties: {
              ...context,
              ...properties,
            },
          });
        }),
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );

  return { layer, captured };
}

describe("platformApiLayer", () => {
  it.effect("fails with PlatformAuthRequiredError when no token is available", () => {
    const layer = Layer.unwrap(makePlatformApiServices).pipe(
      Layer.provide(cliConfigLayer()),
      Layer.provide(credentialsLayer()),
      Layer.provide(commandRuntimeLayer("branches list", "run-no-token")),
      Layer.provide(
        httpClientLayer((request) =>
          Effect.succeed(
            jsonResponse(request, 200, {
              ok: true,
            }),
          ),
        ),
      ),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.gen(function* () {
        return yield* PlatformApi;
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("PlatformAuthRequiredError");
      }
    });
  });

  it.effect("injects auth and shared command headers on every request", () => {
    const seenRequests: Array<{
      authorization: string | undefined;
      userAgent: string | undefined;
      command: string | undefined;
      commandRunId: string | undefined;
    }> = [];

    const layer = Layer.unwrap(makePlatformApiServices).pipe(
      Layer.provide(cliConfigLayer()),
      Layer.provide(credentialsLayer("stored-token")),
      Layer.provide(commandRuntimeLayer("branches list", "run-headers")),
      Layer.provide(
        httpClientLayer((request) => {
          seenRequests.push({
            authorization: request.headers.authorization,
            userAgent: request.headers["user-agent"],
            command: request.headers["x-supabase-command"],
            commandRunId: request.headers["x-supabase-command-run-id"],
          });

          return Effect.succeed(
            jsonResponse(request, 200, [
              {
                id: "00000000-0000-0000-0000-000000000001",
                name: "main",
                project_ref: "mainrefghijklmnopqrst",
                parent_project_ref: "parentrefabcdefghijk",
                is_default: true,
                persistent: true,
                status: "MIGRATIONS_PASSED",
                created_at: "2024-01-15T10:30:00.000Z",
                updated_at: "2024-01-15T10:30:00.000Z",
                with_data: false,
              },
            ]),
          );
        }),
      ),
    );

    return Effect.gen(function* () {
      const api = yield* PlatformApi;
      yield* api.v1.listAllBranches({ ref: "abcdefghijklmnopqrst" });
      yield* api.v1.listAllBranches({ ref: "abcdefghijklmnopqrst" });
      expect(seenRequests).toEqual([
        {
          authorization: "Bearer stored-token",
          userAgent: "@supabase/cli",
          command: "branches list",
          commandRunId: "run-headers",
        },
        {
          authorization: "Bearer stored-token",
          userAgent: "@supabase/cli",
          command: "branches list",
          commandRunId: "run-headers",
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("shares the command run id between analytics and API headers", () => {
    const analytics = mockContextualAnalytics();
    const seenRunIds: string[] = [];
    const runtimeLayer = commandRuntimeLayer("branches list", "run-analytics");

    const layer = Layer.unwrap(makePlatformApiServices).pipe(
      Layer.provide(cliConfigLayer()),
      Layer.provide(credentialsLayer("stored-token")),
      Layer.provide(runtimeLayer),
      Layer.provide(
        httpClientLayer((request) => {
          seenRunIds.push(request.headers["x-supabase-command-run-id"] ?? "");
          return Effect.succeed(
            jsonResponse(request, 200, [
              {
                id: "00000000-0000-0000-0000-000000000001",
                name: "main",
                project_ref: "mainrefghijklmnopqrst",
                parent_project_ref: "parentrefabcdefghijk",
                is_default: true,
                persistent: true,
                status: "MIGRATIONS_PASSED",
                created_at: "2024-01-15T10:30:00.000Z",
                updated_at: "2024-01-15T10:30:00.000Z",
                with_data: false,
              },
            ]),
          );
        }),
      ),
    );

    return Effect.gen(function* () {
      const api = yield* PlatformApi;
      yield* api.v1.listAllBranches({ ref: "abcdefghijklmnopqrst" });
    }).pipe(
      withCommandInstrumentation(),
      Effect.provide(layer),
      Effect.provide(runtimeLayer),
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["branches", "list"]),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(seenRunIds).toEqual(["run-analytics"]);
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.properties.command_run_id).toBe("run-analytics");
        }),
      ),
    );
  });
});
