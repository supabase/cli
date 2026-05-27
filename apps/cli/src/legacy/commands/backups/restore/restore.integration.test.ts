import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeApiClient } from "@supabase/api/effect";
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
import { mockOutput, mockProcessControl, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { legacyBackupsRestore } from "./restore.handler.ts";

const mockLinkedProjectCacheLayer = Layer.succeed(LegacyLinkedProjectCache, {
  cache: () => Effect.void,
});

const mockTelemetryStateLayer = Layer.succeed(LegacyTelemetryState, { flush: Effect.void });

const VALID_REF = "abcdefghijklmnopqrst";
const VALID_TOKEN = "sbp_" + "a".repeat(40);

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

function mockPlatformApi(opts: { status?: number; network?: "fail" }) {
  const requests: Array<{
    url: string;
    method: string;
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
      requests.push({ url: request.url, method: request.method, body });
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
      return HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: opts.status ?? 201 }),
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
  status?: number;
  network?: "fail";
  stdinIsTty?: boolean;
}

let tempRoot: string;
let currentOut: ReturnType<typeof mockOutput>;

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  currentOut = out;
  const api = mockPlatformApi({ status: opts.status, network: opts.network });
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
  return { layer, out, api, tempRoot };
}

const stdoutText = () => currentOut.stdoutText;
const stderrText = () => currentOut.stderrText;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "supabase-backups-restore-int-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("legacy backups restore integration", () => {
  it.live("sends recovery_time_target_unix=0 when --timestamp is omitted", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.none(),
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.body).toEqual({ recovery_time_target_unix: 0 });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends the supplied timestamp when --timestamp is provided", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.some(1_707_407_047),
      });
      expect(api.requests[0]?.body).toEqual({ recovery_time_target_unix: 1_707_407_047 });
    }).pipe(Effect.provide(layer));
  });

  it.live("writes 'Started PITR restore: <ref>\\n' to stderr in text mode (Go parity)", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.none(),
      });
      expect(stderrText()).toBe(`Started PITR restore: ${VALID_REF}\n`);
      expect(stdoutText()).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.none(),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Started PITR restore");
      expect(success?.data).toEqual({ project_ref: VALID_REF });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.none(),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toEqual({ project_ref: VALID_REF });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits indented JSON to stdout for --output json (Go-compat)", () => {
    const { layer } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.none(),
      });
      const out = stdoutText();
      expect(out).toContain('"message": "Started PITR restore"');
      expect(out).toContain(`"project_ref": "${VALID_REF}"`);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "renders the stderr text line for --output {pretty,yaml,toml,env} (Go ignores --output)",
    () => {
      const { layer } = setup({ goOutput: "yaml" });
      return Effect.gen(function* () {
        yield* legacyBackupsRestore({
          projectRef: Option.none(),
          timestamp: Option.none(),
        });
        expect(stderrText()).toBe(`Started PITR restore: ${VALID_REF}\n`);
        expect(stdoutText()).toBe("");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("uses --project-ref flag over LegacyCliConfig.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.some(flagRef),
        timestamp: Option.none(),
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBackupRestoreUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBackupsRestore({ projectRef: Option.none(), timestamp: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyBackupRestoreUnexpectedStatusError");
        expect(errorJson).toContain("unexpected restore backup status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBackupRestoreNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBackupsRestore({ projectRef: Option.none(), timestamp: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyBackupRestoreNetworkError");
        expect(errorJson).toContain("failed to restore backup");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectNotLinkedError non-interactively when no ref source", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "supabase-backups-restore-int-noref-"));
    const out = mockOutput({ format: "text" });
    const api = mockPlatformApi({});
    const cliConfig = Layer.succeed(LegacyCliConfig, {
      profile: "supabase",
      apiUrl: "https://api.supabase.com",
      accessToken: Option.some(Redacted.make(VALID_TOKEN)),
      projectId: Option.none(),
      workdir: tempRoot,
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
        legacyBackupsRestore({ projectRef: Option.none(), timestamp: Option.none() }).pipe(
          Effect.provide(layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectNotLinkedError");
      }
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(tempRoot, { recursive: true, force: true }))));
  });

  it.live("prompts via TTY when no ref source matches and stdin is a TTY", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "supabase-backups-restore-int-prompt-"));
    const out = mockOutput({
      format: "text",
      promptSelectResponses: [VALID_REF],
    });
    const handler = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify([
              {
                id: VALID_REF,
                ref: VALID_REF,
                organization_id: "org_123",
                organization_slug: "acme",
                name: "alpha",
                region: "us-east-1",
                created_at: "2026-01-01T00:00:00Z",
                status: "ACTIVE_HEALTHY",
                database: {
                  host: "db.example.com",
                  version: "15.0",
                  postgres_engine: "supabase-postgres",
                  release_channel: "ga",
                },
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      );
    const api = Layer.effect(
      LegacyPlatformApi,
      makeApiClient({
        baseUrl: "https://api.supabase.com",
        accessToken: VALID_TOKEN,
        userAgent: "SupabaseCLI/0.0.0-dev",
      }),
    ).pipe(Layer.provide(httpClientLayer(handler)));

    const cliConfig = Layer.succeed(LegacyCliConfig, {
      profile: "supabase",
      apiUrl: "https://api.supabase.com",
      accessToken: Option.some(Redacted.make(VALID_TOKEN)),
      projectId: Option.none(),
      workdir: tempRoot,
      userAgent: "SupabaseCLI/0.0.0-dev",
    });
    const processCtl = mockProcessControl();
    const layer = Layer.mergeAll(
      out.layer,
      api,
      cliConfig,
      mockTty({ stdinIsTty: true, stdoutIsTty: true }),
      processCtl.layer,
      legacyProjectRefLayer.pipe(
        Layer.provide(api),
        Layer.provide(cliConfig),
        Layer.provide(mockTty({ stdinIsTty: true, stdoutIsTty: true })),
        Layer.provide(out.layer),
        Layer.provide(BunServices.layer),
      ),
      BunServices.layer,
      Layer.succeed(LegacyOutputFlag, Option.none()),
      mockLinkedProjectCacheLayer,
      mockTelemetryStateLayer,
    );

    return Effect.gen(function* () {
      yield* legacyBackupsRestore({ projectRef: Option.none(), timestamp: Option.none() }).pipe(
        Effect.provide(layer),
      );
      expect(out.promptSelectCalls).toHaveLength(1);
      expect(out.stderrText).toContain(`Started PITR restore: ${VALID_REF}\n`);
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(tempRoot, { recursive: true, force: true }))));
  });

  it.live("accepts --timestamp short alias -t in the same way (no separate parse path)", () => {
    // The flag layer is responsible for parsing -t into `timestamp`; once parsed,
    // the handler does not differentiate, so we just verify the handler honors the value.
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.some(42),
      });
      expect(api.requests[0]?.body).toEqual({ recovery_time_target_unix: 42 });
    }).pipe(Effect.provide(layer));
  });
});
