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
import { legacySslEnforcementUpdate } from "./update.handler.ts";

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

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

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
}) {
  const requests: Array<{
    url: string;
    method: string;
    headers: Readonly<Record<string, string | undefined>>;
    body?: unknown;
  }> = [];

  const handler = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      let body: unknown = undefined;
      if (request.body._tag === "Uint8Array") {
        const decoded = new TextDecoder().decode(request.body.body);
        try {
          body = JSON.parse(decoded);
        } catch {
          body = decoded;
        }
      }
      requests.push({ url: request.url, method: request.method, headers: request.headers, body });

      if (opts.network === "fail") {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: "ECONNREFUSED",
            }),
          }),
        );
      }

      const status = opts.status ?? 200;
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(opts.response ?? SSL_ENFORCED), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    });

  const layer = Layer.effect(
    LegacyPlatformApi,
    makeApiClient({
      baseUrl: "https://api.supabase.com",
      accessToken: VALID_TOKEN,
      userAgent: "SupabaseCLI/0.0.0-dev",
    }),
  ).pipe(Layer.provide(httpClientLayer(handler)));

  return { layer, requests };
}

function mockCliConfig(workdir: string) {
  return Layer.succeed(LegacyCliConfig, {
    profile: "supabase",
    apiUrl: "https://api.supabase.com",
    accessToken: Option.some(Redacted.make(VALID_TOKEN)),
    projectId: Option.some(VALID_REF),
    workdir,
    userAgent: "SupabaseCLI/0.0.0-dev",
  });
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1GetSslEnforcementConfigOutput.Type;
  status?: number;
  network?: "fail";
  stdinIsTty?: boolean;
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
  });
  const cliConfig = mockCliConfig(tempRoot);
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

// ---------------------------------------------------------------------------
// Telemetry + linked-project cache tracking helpers
// ---------------------------------------------------------------------------

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

const mockLinkedProjectCacheLayer = Layer.succeed(LegacyLinkedProjectCache, {
  cache: () => Effect.void,
});

const mockTelemetryStateLayer = Layer.succeed(LegacyTelemetryState, { flush: Effect.void });

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-enforcement-update-int-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy ssl-enforcement update integration", () => {
  // -------------------------------------------------------------------------
  // Flag validation
  // -------------------------------------------------------------------------

  it.live(
    "fails with LegacySslEnforcementNoEnableDisableFlagError when neither flag is set",
    () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySslEnforcementUpdate({
            projectRef: Option.none(),
            enableDbSslEnforcement: false,
            disableDbSslEnforcement: false,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain("LegacySslEnforcementNoEnableDisableFlagError");
          expect(errorJson).toContain("enable/disable not specified");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "fails with LegacySslEnforcementMutuallyExclusiveFlagsError when both flags are set",
    () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySslEnforcementUpdate({
            projectRef: Option.none(),
            enableDbSslEnforcement: true,
            disableDbSslEnforcement: true,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain("LegacySslEnforcementMutuallyExclusiveFlagsError");
          expect(errorJson).toContain(
            "if any flags in the group [enable-db-ssl-enforcement disable-db-ssl-enforcement] are set",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("does not call the API when flag validation fails", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* Effect.exit(
        legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: false,
          disableDbSslEnforcement: false,
        }),
      );
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes telemetry but NOT linked-project cache when validation fails", () => {
    const telemetry = mockTelemetryStateTracked();
    const cache = mockLinkedProjectCacheTracked();
    const out = mockOutput({ format: "text" });
    currentOut = out;
    const api = mockPlatformApi({});
    const cliConfig = mockCliConfig(tempRoot);
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
      yield* Effect.exit(
        legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: false,
          disableDbSslEnforcement: false,
        }),
      );
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Request body
  // -------------------------------------------------------------------------

  it.live("sends requestedConfig.database = true when --enable-db-ssl-enforcement is set", () => {
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.body).toMatchObject({
        requestedConfig: { database: true },
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends requestedConfig.database = false when --disable-db-ssl-enforcement is set", () => {
    const { layer, api } = setup({ response: SSL_NOT_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: false,
        disableDbSslEnforcement: true,
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.body).toMatchObject({
        requestedConfig: { database: false },
      });
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Text output modes (mirroring get scenarios with enable flag)
  // -------------------------------------------------------------------------

  it.live('prints "SSL is being enforced." when database=true and appliedSuccessfully=true', () => {
    const { layer } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(stdoutText()).toBe("SSL is being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live('prints "SSL is *NOT* being enforced." when database=false', () => {
    const { layer } = setup({ response: SSL_NOT_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: false,
        disableDbSslEnforcement: true,
      });
      expect(stdoutText()).toBe("SSL is *NOT* being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    'prints "SSL is *NOT* being enforced." when database=true but appliedSuccessfully=false',
    () => {
      const { layer } = setup({ response: SSL_DESIRED_BUT_NOT_APPLIED });
      return Effect.gen(function* () {
        yield* legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        });
        expect(stdoutText()).toBe("SSL is *NOT* being enforced.\n");
      }).pipe(Effect.provide(layer));
    },
  );

  // -------------------------------------------------------------------------
  // Go output encoders
  // -------------------------------------------------------------------------

  it.live("emits Go-compatible env output for --output env (exact bytes)", () => {
    const { layer } = setup({ goOutput: "env", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(stdoutText()).toBe('APPLIEDSUCCESSFULLY="true"\nCURRENTCONFIG_DATABASE="true"\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible indented JSON for --output json (exact bytes)", () => {
    const { layer } = setup({ goOutput: "json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
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
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      const out = stdoutText();
      expect(out).toContain("appliedSuccessfully: true");
      expect(out).toContain("database: true");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits TOML for --output toml", () => {
    const { layer } = setup({ goOutput: "toml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      const out = stdoutText();
      expect(out).toContain("appliedSuccessfully = true");
      expect(out).toContain("[currentConfig]");
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode", () => {
    const { layer } = setup({ goOutput: "pretty", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(stdoutText()).toBe("SSL is being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // TS output-format modes
  // -------------------------------------------------------------------------

  it.live("emits a JSON success event when --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
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
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ currentConfig: { database: true } });
    }).pipe(Effect.provide(layer));
  });

  it.live("--output (Go) wins over --output-format (TS) when both provided", () => {
    const { layer } = setup({ format: "json", goOutput: "yaml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      const out = stdoutText();
      expect(out).toContain("appliedSuccessfully: true");
      // YAML-shape rather than indented JSON
      expect(out.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Project ref resolution
  // -------------------------------------------------------------------------

  it.live("passes the resolved project ref into the updateSslEnforcementConfig URL", () => {
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/ssl-enforcement`);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.some(flagRef),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads supabase/.temp/project-ref when env and flag are unset", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-update-int-fileref-"));
    const fileRef = "filerefabcdefghijklm";
    mkdirSync(join(localTempRoot, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(localTempRoot, "supabase", ".temp", "project-ref"), fileRef);

    const out = mockOutput({ format: "text" });
    currentOut = out;
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
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${fileRef}/`);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("fails with LegacyProjectNotLinkedError when no ref source matches off-TTY", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-update-int-no-ref-"));
    const out = mockOutput({ format: "text" });
    currentOut = out;
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
        legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        }).pipe(Effect.provide(layer)),
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
        legacySslEnforcementUpdate({
          projectRef: Option.some("BADREF"),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
      }
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it.live("fails with LegacySslEnforcementUpdateUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: SSL_ENFORCED });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacySslEnforcementUpdateUnexpectedStatusError");
        expect(errorJson).toContain("unexpected update SSL status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySslEnforcementUpdateNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacySslEnforcementUpdateNetworkError");
        expect(errorJson).toContain("failed to update ssl enforcement");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
