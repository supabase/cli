import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type V1ListAllSecretsOutput, makeApiClient } from "@supabase/api/effect";
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
import { legacySecretsList } from "./list.handler.ts";

const mockLinkedProjectCacheLayer = Layer.succeed(LegacyLinkedProjectCache, {
  cache: () => Effect.void,
});

const mockTelemetryStateLayer = Layer.succeed(LegacyTelemetryState, { flush: Effect.void });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_REF = "abcdefghijklmnopqrst";
const VALID_TOKEN = "sbp_" + "a".repeat(40);

type SecretsResponse = typeof V1ListAllSecretsOutput.Type;

const SAMPLE_SECRETS: SecretsResponse = [
  { name: "FOO", value: "digest-foo" },
  { name: "BAR", value: "digest-bar" },
];

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
  response?: SecretsResponse;
  status?: number;
  network?: "fail";
  apiUrl?: string;
}) {
  const requests: Array<{
    url: string;
    method: string;
  }> = [];

  const status = opts.status ?? 200;
  const handler = (
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => {
    requests.push({ url: request.url, method: request.method });
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
    return Effect.succeed(jsonResponse(request, status, opts.response ?? []));
  };

  const layer = Layer.effect(
    LegacyPlatformApi,
    makeApiClient({
      baseUrl: opts.apiUrl ?? "https://api.supabase.com",
      accessToken: VALID_TOKEN,
      userAgent: "SupabaseCLI/0.0.0-dev",
    }),
  ).pipe(Layer.provide(httpClientLayer(handler)));

  return { layer, requests };
}

function mockCliConfig(opts: { workdir: string; projectId?: Option.Option<string> }) {
  return Layer.succeed(LegacyCliConfig, {
    profile: "supabase",
    apiUrl: "https://api.supabase.com",
    accessToken: Option.some(Redacted.make(VALID_TOKEN)),
    projectId: opts.projectId ?? Option.some(VALID_REF),
    workdir: opts.workdir,
    userAgent: "SupabaseCLI/0.0.0-dev",
  });
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: SecretsResponse;
  status?: number;
  network?: "fail";
  projectId?: Option.Option<string>;
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
  const cliConfig = mockCliConfig({ workdir: tempRoot, projectId: opts.projectId });
  const processCtl = mockProcessControl();
  const goOutputValue = opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput);
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
    Layer.succeed(LegacyOutputFlag, goOutputValue),
    mockLinkedProjectCacheLayer,
    mockTelemetryStateLayer,
  );
  return { layer, out, api, processCtl };
}

const stdoutText = () => currentOut.stdoutText;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "supabase-secrets-list-int-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy secrets list integration", () => {
  it.live("renders a Glamour ASCII table with NAME and DIGEST columns in text mode", () => {
    const { layer } = setup({ response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("NAME");
      expect(out).toContain("DIGEST");
      expect(out).toContain("BAR");
      expect(out).toContain("FOO");
      expect(out).toContain("digest-foo");
    }).pipe(Effect.provide(layer));
  });

  it.live("sorts secrets alphabetically by name regardless of API response order", () => {
    const { layer } = setup({
      response: [
        { name: "ZED", value: "z-digest" },
        { name: "ALPHA", value: "a-digest" },
        { name: "MID", value: "m-digest" },
      ],
    });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      const out = stdoutText();
      const alphaPos = out.indexOf("ALPHA");
      const midPos = out.indexOf("MID");
      const zedPos = out.indexOf("ZED");
      expect(alphaPos).toBeGreaterThan(-1);
      expect(midPos).toBeGreaterThan(alphaPos);
      expect(zedPos).toBeGreaterThan(midPos);
    }).pipe(Effect.provide(layer));
  });

  it.live("renders literal `|` characters in secret names without escaping (Go parity)", () => {
    const { layer } = setup({
      response: [{ name: "with|pipe", value: "digest" }],
    });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      // Go's pipeline: markdown `\|` → glamour decodes to literal `|`. Our
      // renderer skips the markdown step and emits the literal pipe directly.
      expect(stdoutText()).toContain("with|pipe");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { secrets } for --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        secrets: [
          { name: "BAR", value: "digest-bar" },
          { name: "FOO", value: "digest-foo" },
        ],
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact indented JSON to stdout for --output json", () => {
    const { layer } = setup({ goOutput: "json", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      // Sorted (BAR before FOO) and alphabetical-key JSON; matches Go's struct
      // declaration order for SecretResponse {Name, UpdatedAt, Value}.
      expect(stdoutText()).toBe(
        `[
  {
    "name": "BAR",
    "value": "digest-bar"
  },
  {
    "name": "FOO",
    "value": "digest-foo"
  }
]
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a YAML array to stdout for --output yaml", () => {
    const { layer } = setup({ goOutput: "yaml", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("- name: BAR");
      expect(out).toContain("value: digest-bar");
      expect(out).toContain("- name: FOO");
    }).pipe(Effect.provide(layer));
  });

  it.live("wraps the array as { secrets = [...] } for --output toml", () => {
    const { layer } = setup({ goOutput: "toml", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("[[secrets]]");
      expect(out).toContain('name = "BAR"');
      expect(out).toContain('value = "digest-bar"');
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsEnvNotSupportedError for --output env", () => {
    const { layer } = setup({ goOutput: "env", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySecretsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsEnvNotSupportedError");
        expect(errJson).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode (Glamour table)", () => {
    const { layer } = setup({ goOutput: "pretty", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      expect(stdoutText()).toContain("DIGEST");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output flag value wins over --output-format when both provided", () => {
    const { layer } = setup({
      format: "json",
      goOutput: "yaml",
      response: SAMPLE_SECRETS,
    });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("- name: BAR");
      // YAML shape, not indented JSON.
      expect(out.startsWith("[")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes the resolved project ref into the listAllSecrets URL", () => {
    const { layer, api } = setup({ response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/secrets`);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId env", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: [] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySecretsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsListUnexpectedStatusError");
        expect(errJson).toContain("unexpected list secrets status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySecretsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsListNetworkError");
        expect(errJson).toContain("failed to list secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("withJsonErrorHandling emits a fail event in JSON mode on 503", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: [] });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
