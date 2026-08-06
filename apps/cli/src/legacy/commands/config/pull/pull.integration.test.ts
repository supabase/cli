import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  buildLegacyTestRuntime,
  LEGACY_VALID_REF,
  legacyJsonResponse,
  legacyTransportFailure,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import { legacyConfigPull } from "./pull.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-config-pull-int-");

function writeConfig(): void {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.toml"),
    `project_id = "test"

[auth]
site_url = "http://127.0.0.1:3000"
`,
  );
}

interface SetupOptions {
  readonly response?: unknown;
  readonly rawBody?: string;
  readonly status?: number;
  readonly network?: "fail" | "fail-without-description";
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly configFound?: boolean;
  readonly tracked?: boolean;
}

function setup(options: SetupOptions = {}) {
  if (options.configFound !== false) writeConfig();

  const out = mockOutput({ format: options.format ?? "text" });
  const api = mockLegacyPlatformApi({
    handler: (request) =>
      options.network === "fail"
        ? Effect.fail(legacyTransportFailure(request))
        : options.network === "fail-without-description"
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              }),
            )
          : options.rawBody !== undefined
            ? Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(options.rawBody, {
                    status: options.status ?? 200,
                    headers: { "content-type": "application/json" },
                  }),
                ),
              )
            : Effect.succeed(
                legacyJsonResponse(
                  request,
                  options.status ?? 200,
                  options.response ?? { auth: {}, api: {} },
                ),
              ),
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
    runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
    telemetry: options.tracked ? telemetry.layer : undefined,
    linkedProjectCache: options.tracked ? cache.layer : undefined,
    goOutput: options.goOutput === undefined ? Option.none() : Option.some(options.goOutput),
  });
  return { api, cache, layer, out, telemetry };
}

describe("legacy config pull integration", () => {
  it.live("fetches config for the exact target and reports remote differences", () => {
    const { api, layer, out } = setup({
      response: {
        auth: {
          site_url: "https://preview.example.com",
          additional_redirect_urls: ["https://preview.example.com/auth/callback"],
          unmapped: { nested: null },
        },
        api: {},
      },
    });

    return Effect.gen(function* () {
      yield* legacyConfigPull({ target: "release/v1.2.3" });

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toBe(
        `https://api.supabase.com/v1/projects/${LEGACY_VALID_REF}/config`,
      );
      expect(new URLSearchParams(api.requests[0]?.urlParams).get("branch")).toBe("release/v1.2.3");
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: expect.stringContaining("auth.site_url"),
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: "Found 3 config differences for 'release/v1.2.3'.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reports when the remote config matches local defaults", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyConfigPull({ target: "feature/login" });
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: "Config matches 'feature/login'.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("does not report remote values that equal local values", () => {
    const { layer, out } = setup({
      response: {
        auth: { site_url: "http://127.0.0.1:3000" },
        api: { max_rows: 1000 },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPull({ target: "feature/login" });
      expect(out.messages.filter((message) => message.type === "info")).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses the singular label for one difference", () => {
    const { layer, out } = setup({
      response: { auth: { site_url: "https://preview.example.com" }, api: {} },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPull({ target: "feature/login" });
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: "Found 1 config difference for 'feature/login'.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured diff for JSON output", () => {
    const { layer, out } = setup({
      format: "json",
      response: { auth: { site_url: "https://preview.example.com" }, api: {} },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPull({ target: "feature/login" });
      expect(out.messages.find((message) => message.type === "success")?.data).toMatchObject({
        project_ref: LEGACY_VALID_REF,
        target: "feature/login",
        changes: [
          {
            path: "auth.site_url",
            local: "http://127.0.0.1:3000",
            remote: "https://preview.example.com",
          },
        ],
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured diff for stream JSON output", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyConfigPull({ target: "feature/login" });
      expect(out.messages.find((message) => message.type === "success")).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("honors the legacy machine-output formats", () => {
    const json = setup({ goOutput: "json" });
    const yaml = setup({ goOutput: "yaml" });
    const toml = setup({ goOutput: "toml" });
    const env = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.provide(json.layer));
      yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.provide(yaml.layer));
      yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.provide(toml.layer));
      yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.provide(env.layer));
      expect(json.out.stdoutText).toContain('"target": "feature/login"');
      expect(yaml.out.stdoutText).toContain("target: feature/login");
      expect(toml.out.stdoutText).toContain('target = "feature/login"');
      expect(env.out.stdoutText).toContain('TARGET="feature/login"');
    });
  });

  it.live("fails before reading local config when target is empty", () => {
    const { api, layer } = setup({ configFound: false });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPull({ target: "" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPullTargetEmptyError");
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails before the remote request when local config is missing", () => {
    const { api, layer } = setup({ configFound: false });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPullFileNotFoundError");
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("maps a missing target response to a target error", () => {
    const { layer } = setup({ status: 404, response: { message: "not found" } });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPull({ target: "missing" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPullTargetNotFoundError");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps non-success responses to a status error", () => {
    const { layer } = setup({ status: 503, response: { message: "unavailable" } });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPullStatusError");
      expect(JSON.stringify(exit)).toContain("unexpected config pull status 503");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps transport failures to a network error", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPullNetworkError");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps transport failures without a description to a network error", () => {
    const { layer } = setup({ network: "fail-without-description" });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("TransportError");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects an invalid response shape", () => {
    const { layer } = setup({ response: { auth: {} } });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPullNetworkError");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects invalid JSON", () => {
    const { layer } = setup({ rawBody: "not-json" });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPullStatusError");
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and linked-project state on success and failure", () => {
    const success = setup({ tracked: true });
    return Effect.gen(function* () {
      yield* legacyConfigPull({ target: "feature/login" }).pipe(Effect.provide(success.layer));
      expect(success.telemetry.flushed).toBe(true);
      expect(success.cache.cachedRef).toBe(LEGACY_VALID_REF);

      const failure = setup({ tracked: true, status: 503 });
      yield* legacyConfigPull({ target: "feature/login" }).pipe(
        Effect.provide(failure.layer),
        Effect.exit,
      );
      expect(failure.telemetry.flushed).toBe(true);
      expect(failure.cache.cachedRef).toBe(LEGACY_VALID_REF);
    });
  });
});
