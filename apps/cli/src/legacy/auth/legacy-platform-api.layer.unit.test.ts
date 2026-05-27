import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import { legacyPlatformApiLayer } from "./legacy-platform-api.layer.ts";
import { LegacyPlatformApi } from "./legacy-platform-api.service.ts";

const VALID_TOKEN = "sbp_" + "a".repeat(40);

function mockCliConfig(opts: { accessToken?: string; apiUrl?: string; userAgent?: string }) {
  return Layer.succeed(LegacyCliConfig, {
    profile: "supabase",
    apiUrl: opts.apiUrl ?? "https://api.supabase.com",
    accessToken:
      opts.accessToken === undefined ? Option.none() : Option.some(Redacted.make(opts.accessToken)),
    projectId: Option.none(),
    workdir: "/tmp",
    userAgent: opts.userAgent ?? "SupabaseCLI/0.0.0-dev",
  });
}

function mockCredentials(token: Option.Option<string>) {
  return Layer.succeed(LegacyCredentials, {
    getAccessToken: Effect.succeed(Option.map(token, Redacted.make)),
    saveAccessToken: () => Effect.void,
    deleteAccessToken: Effect.succeed(false),
  });
}

function captureRequests() {
  const requests: Array<{
    url: string;
    headers: Readonly<Record<string, string | undefined>>;
  }> = [];
  const httpClient = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    requests.push({ url: request.url, headers: request.headers });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, httpClient), requests };
}

describe("legacyPlatformApiLayer", () => {
  it.effect("uses env access token over keyring-stored token", () => {
    const http = captureRequests();
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(mockCliConfig({ accessToken: VALID_TOKEN })),
      Layer.provide(mockCredentials(Option.some("sbp_" + "9".repeat(40)))),
      Layer.provide(http.layer),
    );
    return Effect.gen(function* () {
      const api = yield* LegacyPlatformApi;
      yield* api.v1.listAllProjects();
      expect(http.requests).toHaveLength(1);
      expect(http.requests[0]?.headers.authorization).toBe(`Bearer ${VALID_TOKEN}`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses LegacyCredentials.getAccessToken when env is unset", () => {
    const http = captureRequests();
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(mockCliConfig({})),
      Layer.provide(mockCredentials(Option.some(VALID_TOKEN))),
      Layer.provide(http.layer),
    );
    return Effect.gen(function* () {
      const api = yield* LegacyPlatformApi;
      yield* api.v1.listAllProjects();
      expect(http.requests[0]?.headers.authorization).toBe(`Bearer ${VALID_TOKEN}`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with LegacyPlatformAuthRequiredError when no token is configured", () => {
    const http = captureRequests();
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(mockCliConfig({})),
      Layer.provide(mockCredentials(Option.none())),
      Layer.provide(http.layer),
    );
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const api = yield* LegacyPlatformApi;
          return yield* api.v1.listAllProjects();
        }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyPlatformAuthRequiredError");
        expect(errorJson).toContain("Access token not provided");
      }
    });
  });

  it.effect("sends Go-style User-Agent and no X-Supabase-Command headers", () => {
    const http = captureRequests();
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(mockCliConfig({ accessToken: VALID_TOKEN, userAgent: "SupabaseCLI/1.123.4" })),
      Layer.provide(mockCredentials(Option.none())),
      Layer.provide(http.layer),
    );
    return Effect.gen(function* () {
      const api = yield* LegacyPlatformApi;
      yield* api.v1.listAllProjects();
      expect(http.requests[0]?.headers["user-agent"]).toBe("SupabaseCLI/1.123.4");
      expect(http.requests[0]?.headers["x-supabase-command"]).toBeUndefined();
      expect(http.requests[0]?.headers["x-supabase-command-run-id"]).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("targets the configured apiUrl rather than SUPABASE_API_URL env", () => {
    const http = captureRequests();
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(
        mockCliConfig({ accessToken: VALID_TOKEN, apiUrl: "https://api.supabase.green" }),
      ),
      Layer.provide(mockCredentials(Option.none())),
      Layer.provide(http.layer),
    );
    return Effect.gen(function* () {
      const api = yield* LegacyPlatformApi;
      yield* api.v1.listAllProjects();
      expect(http.requests[0]?.url).toContain("https://api.supabase.green/");
    }).pipe(Effect.provide(layer));
  });
});
