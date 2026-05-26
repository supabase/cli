import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type V1GetSslEnforcementConfigOutput, makeApiClient } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { afterEach, beforeEach } from "vitest";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyProjectRefLayer } from "../../../config/legacy-project-ref.layer.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { mockOutput, mockProcessControl, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { legacySslEnforcementGet } from "./get.handler.ts";

const mockLinkedProjectCacheLayer = Layer.succeed(LegacyLinkedProjectCache, {
  cache: () => Effect.void,
});

const mockTelemetryStateLayer = Layer.succeed(LegacyTelemetryState, { flush: Effect.void });

function mockTelemetryStateTracked() {
  let flushed = false;
  const layer = Layer.succeed(LegacyTelemetryState, {
    get flush() {
      return Effect.sync(() => {
        flushed = true;
      });
    },
  });
  return {
    layer,
    get flushed() {
      return flushed;
    },
  };
}

function mockLinkedProjectCacheTracked() {
  let cached = false;
  const layer = Layer.succeed(LegacyLinkedProjectCache, {
    cache: (_ref: string) =>
      Effect.sync(() => {
        cached = true;
      }),
  });
  return {
    layer,
    get cached() {
      return cached;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_REF = "abcdefghijklmnopqrst";
const VALID_TOKEN = "sbp_" + "a".repeat(40);

const SSL_ENFORCED: typeof V1GetSslEnforcementConfigOutput.Type = {
  currentConfig: { database: true },
  appliedSuccessfully: true,
};

const SSL_NOT_ENFORCED: typeof V1GetSslEnforcementConfigOutput.Type = {
  currentConfig: { database: false },
  appliedSuccessfully: false,
};

const SSL_DESIRED_BUT_NOT_APPLIED: typeof V1GetSslEnforcementConfigOutput.Type = {
  currentConfig: { database: true },
  appliedSuccessfully: false,
};

function jsonResponse(request: HttpClientRequest.HttpClientRequest, status: number, body: unknown) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

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

function mockPlatformApi(opts: {
  response?: typeof V1GetSslEnforcementConfigOutput.Type;
  status?: number;
  network?: "fail";
  apiUrl?: string;
  userAgent?: string;
}) {
  const requests: Array<{
    url: string;
    method: string;
    headers: Readonly<Record<string, string | undefined>>;
  }> = [];

  const status = opts.status ?? 200;
  const handler = (
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => {
    requests.push({ url: request.url, method: request.method, headers: request.headers });
    if (opts.network === "fail") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "ECONNREFUSED",
          }),
        }),
      );
    }
    return Effect.succeed(jsonResponse(request, status, opts.response ?? SSL_ENFORCED));
  };

  const layer = Layer.effect(
    LegacyPlatformApi,
    makeApiClient({
      baseUrl: opts.apiUrl ?? "https://api.supabase.com",
      accessToken: VALID_TOKEN,
      userAgent: opts.userAgent ?? "SupabaseCLI/0.0.0-dev",
    }),
  ).pipe(Layer.provide(httpClientLayer(handler)));

  return { layer, requests };
}

function mockCliConfig(opts: { workdir: string; apiUrl?: string; userAgent?: string }) {
  return Layer.succeed(LegacyCliConfig, {
    profile: "supabase",
    apiUrl: opts.apiUrl ?? "https://api.supabase.com",
    accessToken: Option.some(Redacted.make(VALID_TOKEN)),
    projectId: Option.some(VALID_REF),
    workdir: opts.workdir,
    userAgent: opts.userAgent ?? "SupabaseCLI/0.0.0-dev",
  });
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1GetSslEnforcementConfigOutput.Type;
  status?: number;
  network?: "fail";
  stdinIsTty?: boolean;
  apiUrl?: string;
  userAgent?: string;
}

let tempRoot: string;
let currentOut: ReturnType<typeof mockOutput>;

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  currentOut = out;
  const api = mockPlatformApi({
    response: opts.response,
    status: opts.status,
    network: opts.network,
    apiUrl: opts.apiUrl,
    userAgent: opts.userAgent,
  });
  const cliConfig = mockCliConfig({
    workdir: tempRoot,
    apiUrl: opts.apiUrl,
    userAgent: opts.userAgent,
  });
  const processCtl = mockProcessControl();
  const goOutputValue = opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput);
  const layer = Layer.mergeAll(
    out.layer,
    api.layer,
    cliConfig,
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    processCtl.layer,
    legacyProjectRefLayer.pipe(
      Layer.provide(api.layer),
      Layer.provide(cliConfig),
      Layer.provide(mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false })),
      Layer.provide(out.layer),
      Layer.provide(BunServices.layer),
    ),
    BunServices.layer,
    Layer.succeed(LegacyOutputFlag, goOutputValue),
    mockLinkedProjectCacheLayer,
    mockTelemetryStateLayer,
  );
  return { layer, out, api, processCtl, tempRoot };
}

const stdoutText = () => currentOut.stdoutText;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-enforcement-get-int-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy ssl-enforcement get integration", () => {
  it.live('prints "SSL is being enforced." when database=true and appliedSuccessfully=true', () => {
    const { layer } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(stdoutText()).toBe("SSL is being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live('prints "SSL is *NOT* being enforced." when database=false', () => {
    const { layer } = setup({ response: SSL_NOT_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(stdoutText()).toBe("SSL is *NOT* being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    'prints "SSL is *NOT* being enforced." when database=true but appliedSuccessfully=false',
    () => {
      const { layer } = setup({ response: SSL_DESIRED_BUT_NOT_APPLIED });
      return Effect.gen(function* () {
        yield* legacySslEnforcementGet({ projectRef: Option.none() });
        expect(stdoutText()).toBe("SSL is *NOT* being enforced.\n");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("emits Go-compatible env output for --output env (exact bytes)", () => {
    const { layer } = setup({ goOutput: "env", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(stdoutText()).toBe('APPLIEDSUCCESSFULLY="true"\nCURRENTCONFIG_DATABASE="true"\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible indented JSON for --output json (exact bytes)", () => {
    const { layer } = setup({ goOutput: "json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(stdoutText()).toBe(
        `{
  "appliedSuccessfully": true,
  "currentConfig": {
    "database": true
  }
}
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits YAML for --output yaml", () => {
    const { layer } = setup({ goOutput: "yaml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("appliedSuccessfully: true");
      expect(out).toContain("database: true");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits TOML for --output toml", () => {
    const { layer } = setup({ goOutput: "toml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("appliedSuccessfully = true");
      expect(out).toContain("[currentConfig]");
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode", () => {
    const { layer } = setup({ goOutput: "pretty", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(stdoutText()).toBe("SSL is being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event when --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        currentConfig: { database: true },
        appliedSuccessfully: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ currentConfig: { database: true } });
    }).pipe(Effect.provide(layer));
  });

  it.live("--output (Go) wins over --output-format (TS) when both provided", () => {
    const { layer } = setup({ format: "json", goOutput: "yaml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("appliedSuccessfully: true");
      // YAML-shape rather than indented JSON
      expect(out.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes the resolved project ref into the getSslEnforcementConfig URL", () => {
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/ssl-enforcement`);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads supabase/.temp/project-ref when env and flag are unset", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-get-int-fileref-"));
    const fileRef = "filerefabcdefghijklm";
    mkdirSync(join(localTempRoot, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(localTempRoot, "supabase", ".temp", "project-ref"), fileRef);

    const out = mockOutput({ format: "text" });
    const api = mockPlatformApi({ response: SSL_ENFORCED });
    const cliConfig = Layer.succeed(LegacyCliConfig, {
      profile: "supabase",
      apiUrl: "https://api.supabase.com",
      accessToken: Option.some(Redacted.make(VALID_TOKEN)),
      projectId: Option.none(),
      workdir: localTempRoot,
      userAgent: "SupabaseCLI/0.0.0-dev",
    });
    const processCtl = mockProcessControl();
    const layer = Layer.mergeAll(
      out.layer,
      api.layer,
      cliConfig,
      mockTty({ stdinIsTty: false, stdoutIsTty: false }),
      processCtl.layer,
      legacyProjectRefLayer.pipe(
        Layer.provide(api.layer),
        Layer.provide(cliConfig),
        Layer.provide(mockTty({ stdinIsTty: false, stdoutIsTty: false })),
        Layer.provide(out.layer),
        Layer.provide(BunServices.layer),
      ),
      BunServices.layer,
      Layer.succeed(LegacyOutputFlag, Option.none()),
      mockLinkedProjectCacheLayer,
      mockTelemetryStateLayer,
    );

    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${fileRef}/`);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("fails with LegacyProjectNotLinkedError when no ref source matches off-TTY", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-get-int-no-ref-"));
    const out = mockOutput({ format: "text" });
    const api = mockPlatformApi({ response: SSL_ENFORCED });
    const cliConfig = Layer.succeed(LegacyCliConfig, {
      profile: "supabase",
      apiUrl: "https://api.supabase.com",
      accessToken: Option.some(Redacted.make(VALID_TOKEN)),
      projectId: Option.none(),
      workdir: localTempRoot,
      userAgent: "SupabaseCLI/0.0.0-dev",
    });
    const processCtl = mockProcessControl();
    const layer = Layer.mergeAll(
      out.layer,
      api.layer,
      cliConfig,
      mockTty({ stdinIsTty: false, stdoutIsTty: false }),
      processCtl.layer,
      legacyProjectRefLayer.pipe(
        Layer.provide(api.layer),
        Layer.provide(cliConfig),
        Layer.provide(mockTty({ stdinIsTty: false, stdoutIsTty: false })),
        Layer.provide(out.layer),
        Layer.provide(BunServices.layer),
      ),
      BunServices.layer,
      Layer.succeed(LegacyOutputFlag, Option.none()),
      mockLinkedProjectCacheLayer,
      mockTelemetryStateLayer,
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementGet({ projectRef: Option.none() }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectNotLinkedError");
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("fails with LegacyInvalidProjectRefError when the resolved ref is malformed", () => {
    const { layer } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementGet({ projectRef: Option.some("BADREF") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySslEnforcementGetUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: SSL_ENFORCED });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySslEnforcementGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacySslEnforcementGetUnexpectedStatusError");
        expect(errorJson).toContain("unexpected SSL enforcement status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySslEnforcementGetNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySslEnforcementGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacySslEnforcementGetNetworkError");
        expect(errorJson).toContain("failed to retrieve SSL enforcement config");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // PersistentPostRun parity — telemetry + linked-project cache scoping
  // -------------------------------------------------------------------------

  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const telemetry = mockTelemetryStateTracked();
    const cache = mockLinkedProjectCacheTracked();
    const out = mockOutput({ format: "text" });
    const api = mockPlatformApi({ response: SSL_ENFORCED });
    const cliConfig = mockCliConfig({ workdir: tempRoot });
    const processCtl = mockProcessControl();
    const layer = Layer.mergeAll(
      out.layer,
      api.layer,
      cliConfig,
      mockTty({ stdinIsTty: false, stdoutIsTty: false }),
      processCtl.layer,
      legacyProjectRefLayer.pipe(
        Layer.provide(api.layer),
        Layer.provide(cliConfig),
        Layer.provide(mockTty({ stdinIsTty: false, stdoutIsTty: false })),
        Layer.provide(out.layer),
        Layer.provide(BunServices.layer),
      ),
      BunServices.layer,
      Layer.succeed(LegacyOutputFlag, Option.none()),
      cache.layer,
      telemetry.layer,
    );
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even when ref resolution fails (no cache write)", () => {
    // Pre-PersistentPostRun-fix regression guard: telemetry must flush whether or not the
    // resolver succeeds. The linked-project cache only writes after a ref is resolved.
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-get-int-postrun-"));
    const telemetry = mockTelemetryStateTracked();
    const cache = mockLinkedProjectCacheTracked();
    const out = mockOutput({ format: "text" });
    const api = mockPlatformApi({ response: SSL_ENFORCED });
    const cliConfig = Layer.succeed(LegacyCliConfig, {
      profile: "supabase",
      apiUrl: "https://api.supabase.com",
      accessToken: Option.some(Redacted.make(VALID_TOKEN)),
      projectId: Option.none(),
      workdir: localTempRoot,
      userAgent: "SupabaseCLI/0.0.0-dev",
    });
    const processCtl = mockProcessControl();
    const layer = Layer.mergeAll(
      out.layer,
      api.layer,
      cliConfig,
      mockTty({ stdinIsTty: false, stdoutIsTty: false }),
      processCtl.layer,
      legacyProjectRefLayer.pipe(
        Layer.provide(api.layer),
        Layer.provide(cliConfig),
        Layer.provide(mockTty({ stdinIsTty: false, stdoutIsTty: false })),
        Layer.provide(out.layer),
        Layer.provide(BunServices.layer),
      ),
      BunServices.layer,
      Layer.succeed(LegacyOutputFlag, Option.none()),
      cache.layer,
      telemetry.layer,
    );
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementGet({ projectRef: Option.none() }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });
});
