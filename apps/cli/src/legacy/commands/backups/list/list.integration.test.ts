import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type V1ListAllBackupsOutput, makeApiClient } from "@supabase/api/effect";
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
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { mockProcessControl } from "../../../../../tests/helpers/mocks.ts";
import { legacyBackupsList } from "./list.handler.ts";

const mockLinkedProjectCacheLayer = Layer.succeed(LegacyLinkedProjectCache, {
  cache: () => Effect.void,
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_REF = "abcdefghijklmnopqrst";
const VALID_TOKEN = "sbp_" + "a".repeat(40);

const PITR_RESPONSE: typeof V1ListAllBackupsOutput.Type = {
  region: "ap-southeast-1",
  walg_enabled: true,
  pitr_enabled: true,
  backups: [],
  physical_backup_data: {},
};

const LOGICAL_RESPONSE: typeof V1ListAllBackupsOutput.Type = {
  region: "ap-southeast-1",
  walg_enabled: true,
  pitr_enabled: true,
  backups: [
    {
      id: 1,
      is_physical_backup: true,
      status: "COMPLETED",
      inserted_at: "2026-02-08T16:44:07Z",
    },
  ],
  physical_backup_data: {},
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
  response?: typeof V1ListAllBackupsOutput.Type;
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
    return Effect.succeed(jsonResponse(request, status, opts.response ?? PITR_RESPONSE));
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
  response?: typeof V1ListAllBackupsOutput.Type;
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
  );
  return { layer, out, api, processCtl, tempRoot };
}

const stdoutText = () => currentOut.stdoutText;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "supabase-backups-list-int-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy backups list integration", () => {
  it.live("renders a PITR-only table when no physical backups exist", () => {
    const { layer } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("REGION");
      expect(out).toContain("WALG");
      expect(out).toContain("PITR");
      expect(out).toContain("EARLIEST TIMESTAMP");
      expect(out).toContain("LATEST TIMESTAMP");
      expect(out).toContain("Southeast Asia (Singapore)");
      expect(out).toContain("| true ");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders a logical backups table with PHYSICAL classification", () => {
    const { layer } = setup({ response: LOGICAL_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("BACKUP TYPE");
      expect(out).toContain("PHYSICAL");
      expect(out).toContain("COMPLETED");
      expect(out).toContain("2026-02-08 16:44:07");
    }).pipe(Effect.provide(layer));
  });

  it.live("translates ap-southeast-1 to Southeast Asia (Singapore)", () => {
    const { layer } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(stdoutText()).toContain("Southeast Asia (Singapore)");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event when --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ region: "ap-southeast-1", walg_enabled: true });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ region: "ap-southeast-1" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits indented JSON to stdout for --output json (Go-compat)", () => {
    const { layer } = setup({ goOutput: "json", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      // Byte-identical to Go's `encoding/json` output: alphabetical struct-field order,
      // and a nil Backups slice serializes as `null` (matches
      // `apps/cli-go/internal/backups/list/list_test.go` fixture).
      expect(stdoutText()).toBe(
        `{
  "backups": null,
  "physical_backup_data": {},
  "pitr_enabled": true,
  "region": "ap-southeast-1",
  "walg_enabled": true
}
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits YAML to stdout for --output yaml", () => {
    const { layer } = setup({ goOutput: "yaml", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("region: ap-southeast-1");
      expect(out).toContain("walg_enabled: true");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits TOML to stdout for --output toml", () => {
    const { layer } = setup({ goOutput: "toml", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain('region = "ap-southeast-1"');
      expect(out).toContain("walg_enabled = true");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits KEY=VALUE lines for --output env", () => {
    const { layer } = setup({ goOutput: "env", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain('REGION="ap-southeast-1"');
      expect(out).toContain('WALG_ENABLED="true"');
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode (Glamour table)", () => {
    const { layer } = setup({ goOutput: "pretty", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(stdoutText()).toContain("Southeast Asia (Singapore)");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output flag value wins over --output-format when both provided", () => {
    const { layer } = setup({
      format: "json",
      goOutput: "yaml",
      response: PITR_RESPONSE,
    });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      const out = stdoutText();
      expect(out).toContain("region: ap-southeast-1");
      // YAML-shape rather than indented JSON.
      expect(out.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes the resolved project ref into the listAllBackups URL", () => {
    const { layer, api } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/database/backups`);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId env", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads supabase/.temp/project-ref when env and flag are unset", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "supabase-backups-list-int-fileref-"));
    const fileRef = "filerefabcdefghijklm";
    mkdirSync(join(tempRoot, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(tempRoot, "supabase", ".temp", "project-ref"), fileRef);

    const out = mockOutput({ format: "text" });
    const api = mockPlatformApi({ response: PITR_RESPONSE });
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
    );

    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${fileRef}/`);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(tempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("fails with LegacyProjectNotLinkedError when no ref source matches off-TTY", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "supabase-backups-list-int-no-ref-"));
    const out = mockOutput({ format: "text" });
    const api = mockPlatformApi({ response: PITR_RESPONSE });
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
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBackupsList({ projectRef: Option.none() }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectNotLinkedError");
      }
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(tempRoot, { recursive: true, force: true }))));
  });

  it.live("fails with LegacyInvalidProjectRefError when the resolved ref is malformed", () => {
    const { layer } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyBackupsList({ projectRef: Option.some("BADREF") }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBackupListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: PITR_RESPONSE });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyBackupsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyBackupListUnexpectedStatusError");
        expect(errorJson).toContain("unexpected list backup status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBackupListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyBackupsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyBackupListNetworkError");
        expect(errorJson).toContain("failed to list physical backups");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "sends User-Agent SupabaseCLI/<version> and no X-Supabase-Command headers (Go parity)",
    () => {
      const { layer, api } = setup({
        response: PITR_RESPONSE,
        userAgent: "SupabaseCLI/1.42.0",
      });
      return Effect.gen(function* () {
        yield* legacyBackupsList({ projectRef: Option.none() });
        const headers = api.requests[0]?.headers;
        expect(headers?.["user-agent"]).toBe("SupabaseCLI/1.42.0");
        expect(headers?.["x-supabase-command"]).toBeUndefined();
        expect(headers?.["x-supabase-command-run-id"]).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );
});
