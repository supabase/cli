import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import { legacyPlatformApiLayer } from "./legacy-platform-api.layer.ts";
import { LegacyPlatformApi } from "./legacy-platform-api.service.ts";

const VALID_TOKEN = "sbp_" + "a".repeat(40);
const SESSION_LAST_ACTIVE = 1_777_200_000_000;

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

function mockTelemetryRuntime(
  opts: {
    configDir?: string;
    deviceId?: string;
    distinctId?: string;
    isFirstRun?: boolean;
    isTty?: boolean;
    isCi?: boolean;
  } = {},
) {
  return Layer.succeed(
    TelemetryRuntime,
    TelemetryRuntime.of({
      configDir: opts.configDir ?? "/tmp/supabase-cli-test-home",
      tracesDir: path.join(opts.configDir ?? "/tmp/supabase-cli-test-home", "traces"),
      consent: "granted",
      showDebug: false,
      deviceId: opts.deviceId ?? "device-123",
      sessionId: "session-123",
      ...(opts.distinctId === undefined ? {} : { distinctId: opts.distinctId }),
      isFirstRun: opts.isFirstRun ?? false,
      isTty: opts.isTty ?? false,
      isCi: opts.isCi ?? false,
      os: "darwin",
      arch: "arm64",
      cliVersion: "0.0.0-test",
    }),
  );
}

function mockAnalytics() {
  const aliases: Array<{ distinctId: string; alias: string }> = [];
  const identifies: Array<{ distinctId: string; properties: Record<string, unknown> }> = [];

  const layer = Layer.succeed(
    Analytics,
    Analytics.of({
      capture: () => Effect.void,
      identify: (distinctId, properties = {}) =>
        Effect.sync(() => {
          identifies.push({ distinctId, properties });
        }),
      alias: (distinctId, alias) =>
        Effect.sync(() => {
          aliases.push({ distinctId, alias });
        }),
      groupIdentify: () => Effect.void,
    }),
  );

  return { layer, aliases, identifies };
}

function nodeFileSystemLayer() {
  return Layer.succeed(FileSystem.FileSystem, {
    [FileSystem.FileSystem.key]: FileSystem.FileSystem.key,
    exists: (filePath: string) =>
      Effect.tryPromise(() =>
        access(filePath)
          .then(() => true)
          .catch(() => false),
      ),
    makeDirectory: (dirPath: string, opts?: { recursive?: boolean; mode?: number }) =>
      Effect.tryPromise(() =>
        mkdir(dirPath, { recursive: opts?.recursive, mode: opts?.mode }).then(() => undefined),
      ),
    readFileString: (filePath: string) => Effect.tryPromise(() => readFile(filePath, "utf8")),
    writeFileString: (filePath: string, content: string, opts?: { mode?: number }) =>
      Effect.tryPromise(() => writeFile(filePath, content, { mode: opts?.mode })),
  } as unknown as FileSystem.FileSystem);
}

function nodePathLayer() {
  return Layer.succeed(Path.Path, {
    [Path.Path.key]: Path.Path.key,
    ...path,
  } as unknown as Path.Path);
}

function tempTelemetryConfig(opts: { distinctId?: string; enabled?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-legacy-platform-api-"));
  writeFileSync(
    path.join(dir, "telemetry.json"),
    JSON.stringify({
      enabled: opts.enabled ?? true,
      device_id: "device-123",
      session_id: "session-123",
      session_last_active: new Date(SESSION_LAST_ACTIVE).toISOString(),
      ...(opts.distinctId === undefined ? {} : { distinct_id: opts.distinctId }),
      schema_version: 1,
    }),
  );
  return dir;
}

function readTelemetryConfig(configDir: string) {
  return JSON.parse(readFileSync(path.join(configDir, "telemetry.json"), "utf8")) as {
    enabled?: boolean;
    distinct_id?: string;
    schema_version?: number;
  };
}

function withBaseDeps(
  opts: {
    analytics?: ReturnType<typeof mockAnalytics>;
    configDir?: string;
    distinctId?: string;
    isFirstRun?: boolean;
    isTty?: boolean;
    isCi?: boolean;
  } = {},
) {
  const analytics = opts.analytics ?? mockAnalytics();
  return <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
    layer.pipe(
      Layer.provide(analytics.layer),
      Layer.provide(
        mockTelemetryRuntime({
          configDir: opts.configDir,
          distinctId: opts.distinctId,
          isFirstRun: opts.isFirstRun,
          isTty: opts.isTty,
          isCi: opts.isCi,
        }),
      ),
      Layer.provide(nodeFileSystemLayer()),
      Layer.provide(nodePathLayer()),
    );
}

function captureRequests(responseHeaders: Record<string, string> = {}) {
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
          headers: { "content-type": "application/json", ...responseHeaders },
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
      withBaseDeps(),
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
      withBaseDeps(),
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
      withBaseDeps(),
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
      withBaseDeps(),
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
      withBaseDeps(),
    );
    return Effect.gen(function* () {
      const api = yield* LegacyPlatformApi;
      yield* api.v1.listAllProjects();
      expect(http.requests[0]?.url).toContain("https://api.supabase.green/");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stitches identity from X-Gotrue-Id responses outside CI", () => {
    const configDir = tempTelemetryConfig();
    const analytics = mockAnalytics();
    const http = captureRequests({ "X-Gotrue-Id": "user-123" });
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(mockCliConfig({ accessToken: VALID_TOKEN })),
      Layer.provide(mockCredentials(Option.none())),
      Layer.provide(http.layer),
      withBaseDeps({ analytics, configDir }),
    );

    return Effect.gen(function* () {
      try {
        const api = yield* LegacyPlatformApi;
        yield* api.v1.listAllProjects();

        expect(analytics.aliases).toEqual([{ distinctId: "user-123", alias: "device-123" }]);
        expect(analytics.identifies).toEqual([]);
        const telemetry = readTelemetryConfig(configDir);
        expect(telemetry.distinct_id).toBe("user-123");
        expect(telemetry.enabled).toBe(true);
        expect(telemetry.schema_version).toBe(1);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not stitch identity from X-Gotrue-Id responses in CI", () => {
    const configDir = tempTelemetryConfig();
    const analytics = mockAnalytics();
    const http = captureRequests({ "X-Gotrue-Id": "user-123" });
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(mockCliConfig({ accessToken: VALID_TOKEN })),
      Layer.provide(mockCredentials(Option.none())),
      Layer.provide(http.layer),
      withBaseDeps({ analytics, configDir, isCi: true }),
    );

    return Effect.gen(function* () {
      try {
        const api = yield* LegacyPlatformApi;
        yield* api.v1.listAllProjects();

        expect(analytics.aliases).toEqual([]);
        expect(analytics.identifies).toEqual([]);
        expect(readTelemetryConfig(configDir).distinct_id).toBeUndefined();
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not stitch identity in a first-run non-TTY runtime", () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "supabase-legacy-platform-api-"));
    const analytics = mockAnalytics();
    const http = captureRequests({ "X-Gotrue-Id": "user-123" });
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(mockCliConfig({ accessToken: VALID_TOKEN })),
      Layer.provide(mockCredentials(Option.none())),
      Layer.provide(http.layer),
      withBaseDeps({ analytics, configDir, isFirstRun: true, isTty: false }),
    );

    return Effect.gen(function* () {
      try {
        const api = yield* LegacyPlatformApi;
        yield* api.v1.listAllProjects();

        expect(analytics.aliases).toEqual([]);
        expect(analytics.identifies).toEqual([]);
        expect(existsSync(path.join(configDir, "telemetry.json"))).toBe(false);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("stitches identity in a first-run TTY runtime", () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "supabase-legacy-platform-api-"));
    const analytics = mockAnalytics();
    const http = captureRequests({ "X-Gotrue-Id": "user-123" });
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(mockCliConfig({ accessToken: VALID_TOKEN })),
      Layer.provide(mockCredentials(Option.none())),
      Layer.provide(http.layer),
      withBaseDeps({ analytics, configDir, isFirstRun: true, isTty: true }),
    );

    return Effect.gen(function* () {
      try {
        const api = yield* LegacyPlatformApi;
        yield* api.v1.listAllProjects();

        expect(analytics.aliases).toEqual([{ distinctId: "user-123", alias: "device-123" }]);
        expect(analytics.identifies).toEqual([]);
        expect(readTelemetryConfig(configDir).distinct_id).toBe("user-123");
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not stitch identity when a distinct_id is already known", () => {
    const configDir = tempTelemetryConfig({ distinctId: "existing-user" });
    const analytics = mockAnalytics();
    const http = captureRequests({ "X-Gotrue-Id": "user-123" });
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(mockCliConfig({ accessToken: VALID_TOKEN })),
      Layer.provide(mockCredentials(Option.none())),
      Layer.provide(http.layer),
      withBaseDeps({ analytics, configDir, distinctId: "existing-user" }),
    );

    return Effect.gen(function* () {
      try {
        const api = yield* LegacyPlatformApi;
        yield* api.v1.listAllProjects();

        expect(analytics.aliases).toEqual([]);
        expect(analytics.identifies).toEqual([]);
        expect(readTelemetryConfig(configDir).distinct_id).toBe("existing-user");
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not stitch identity when legacy telemetry state is disabled", () => {
    const configDir = tempTelemetryConfig({ enabled: false });
    const analytics = mockAnalytics();
    const http = captureRequests({ "X-Gotrue-Id": "user-123" });
    const layer = legacyPlatformApiLayer.pipe(
      Layer.provide(mockCliConfig({ accessToken: VALID_TOKEN })),
      Layer.provide(mockCredentials(Option.none())),
      Layer.provide(http.layer),
      withBaseDeps({ analytics, configDir }),
    );

    return Effect.gen(function* () {
      try {
        const api = yield* LegacyPlatformApi;
        yield* api.v1.listAllProjects();

        expect(analytics.aliases).toEqual([]);
        expect(analytics.identifies).toEqual([]);
        const telemetry = readTelemetryConfig(configDir);
        expect(telemetry.enabled).toBe(false);
        expect(telemetry.distinct_id).toBeUndefined();
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(layer));
  });
});
