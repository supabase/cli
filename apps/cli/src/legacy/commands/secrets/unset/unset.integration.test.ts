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
import { LegacyOutputFlag, LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { mockOutput, mockProcessControl, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { legacySecretsUnset } from "./unset.handler.ts";

const mockLinkedProjectCacheLayer = Layer.succeed(LegacyLinkedProjectCache, {
  cache: () => Effect.void,
});

const mockTelemetryStateLayer = Layer.succeed(LegacyTelemetryState, { flush: Effect.void });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_REF = "abcdefghijklmnopqrst";
const VALID_TOKEN = "sbp_" + "a".repeat(40);

type SecretsList = typeof V1ListAllSecretsOutput.Type;

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

interface ApiRequest {
  url: string;
  method: string;
  body: string;
}

function mockPlatformApi(
  opts: {
    list?: SecretsList;
    listStatus?: number;
    listNetwork?: "fail";
    deleteStatus?: number;
    deleteNetwork?: "fail";
  } = {},
) {
  const requests: ApiRequest[] = [];

  const handler = (
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => {
    return Effect.gen(function* () {
      const body =
        request.body._tag === "Uint8Array"
          ? new TextDecoder().decode(request.body.body)
          : request.body._tag === "Raw"
            ? String(request.body.body)
            : "";
      requests.push({ url: request.url, method: request.method, body });

      if (request.method === "GET") {
        if (opts.listNetwork === "fail") {
          return yield* Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "ECONNREFUSED",
              }),
            }),
          );
        }
        return jsonResponse(request, opts.listStatus ?? 200, opts.list ?? []);
      }

      // DELETE
      if (opts.deleteNetwork === "fail") {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: "ECONNREFUSED",
            }),
          }),
        );
      }
      return jsonResponse(request, opts.deleteStatus ?? 200, null);
    });
  };

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

function mockCliConfig(opts: { workdir: string }) {
  return Layer.succeed(LegacyCliConfig, {
    profile: "supabase",
    apiUrl: "https://api.supabase.com",
    accessToken: Option.some(Redacted.make(VALID_TOKEN)),
    projectId: Option.some(VALID_REF),
    workdir: opts.workdir,
    userAgent: "SupabaseCLI/0.0.0-dev",
  });
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "pretty" | "json" | "yaml" | "toml" | "env";
  yes?: boolean;
  stdinIsTty?: boolean;
  confirm?: boolean;
  list?: SecretsList;
  listStatus?: number;
  listNetwork?: "fail";
  deleteStatus?: number;
  deleteNetwork?: "fail";
}

let tempRoot: string;
let currentOut: ReturnType<typeof mockOutput>;

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    confirmLogout: opts.confirm,
  });
  currentOut = out;
  const api = mockPlatformApi({
    list: opts.list,
    listStatus: opts.listStatus,
    listNetwork: opts.listNetwork,
    deleteStatus: opts.deleteStatus,
    deleteNetwork: opts.deleteNetwork,
  });
  const cliConfig = mockCliConfig({ workdir: tempRoot });
  const processCtl = mockProcessControl();
  const tty = mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false });
  const goOutputValue = opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput);

  const layer = Layer.mergeAll(
    out.layer,
    api.layer,
    cliConfig,
    tty,
    processCtl.layer,
    legacyProjectRefLayer.pipe(
      Layer.provide(api.layer),
      Layer.provide(cliConfig),
      Layer.provide(tty),
      Layer.provide(out.layer),
      Layer.provide(BunServices.layer),
    ),
    BunServices.layer,
    Layer.succeed(LegacyOutputFlag, goOutputValue),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    mockLinkedProjectCacheLayer,
    mockTelemetryStateLayer,
  );
  return { layer, out, api };
}

const stderrText = () => currentOut.stderrText;
const stdoutText = () => currentOut.stdoutText;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "supabase-secrets-unset-int-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function parseDeleteBody(body: string): string[] {
  return JSON.parse(body) as string[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy secrets unset integration", () => {
  it.live("unsets a single secret given explicitly (with --yes)", () => {
    const { layer, api } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      // No GET call: names came from args.
      expect(api.requests.filter((r) => r.method === "GET")).toHaveLength(0);
      const deletes = api.requests.filter((r) => r.method === "DELETE");
      expect(deletes).toHaveLength(1);
      expect(parseDeleteBody(deletes[0]!.body)).toEqual(["FOO"]);
      expect(stdoutText()).toBe("Finished supabase secrets unset.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("unsets multiple secrets given explicitly", () => {
    const { layer, api } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({
        projectRef: Option.none(),
        names: ["FOO", "BAR"],
      });
      const deletes = api.requests.filter((r) => r.method === "DELETE");
      expect(parseDeleteBody(deletes[0]!.body)).toEqual(["FOO", "BAR"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("empty-args path lists secrets and DELETEs the non-SUPABASE_ subset", () => {
    const { layer, api } = setup({
      yes: true,
      list: [
        { name: "FOO", value: "d1" },
        { name: "SUPABASE_AUTH_TOKEN", value: "d2" },
        { name: "BAR", value: "d3" },
      ],
    });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: [] });
      const gets = api.requests.filter((r) => r.method === "GET");
      const deletes = api.requests.filter((r) => r.method === "DELETE");
      expect(gets).toHaveLength(1);
      expect(parseDeleteBody(deletes[0]!.body)).toEqual(["FOO", "BAR"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("empty-args path with all-SUPABASE_ secrets writes stderr no-op and exits 0", () => {
    const { layer, api } = setup({
      yes: true,
      list: [{ name: "SUPABASE_ONLY", value: "d" }],
    });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: [] });
      expect(stderrText()).toContain("You have not set any function secrets, nothing to do.");
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("empty-args path with empty server list writes the stderr no-op and exits 0", () => {
    const { layer, api } = setup({ yes: true, list: [] });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: [] });
      expect(stderrText()).toContain("You have not set any function secrets, nothing to do.");
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("--yes bypasses the prompt and echoes [Y/n] y to stderr", () => {
    const { layer } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      const stderr = stderrText();
      expect(stderr).toContain("Do you want to unset these function secrets?");
      expect(stderr).toContain(" • FOO");
      expect(stderr).toContain("[Y/n] y");
    }).pipe(Effect.provide(layer));
  });

  it.live("non-TTY without --yes auto-confirms silently (Go parity)", () => {
    const { layer, api } = setup({ yes: false, stdinIsTty: false });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      // Go's PromptYesNo defaults to true after 100ms non-TTY read timeout — no stderr echo.
      expect(stderrText()).not.toContain("[Y/n]");
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("TTY without --yes prompts via output.promptConfirm and proceeds on accept", () => {
    const { layer, api } = setup({ yes: false, stdinIsTty: true, confirm: true });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("TTY without --yes fails with LegacySecretsUnsetCancelledError on decline", () => {
    const { layer, api } = setup({ yes: false, stdinIsTty: true, confirm: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySecretsUnsetCancelledError");
      }
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsListNetworkError on GET failure (empty-args path)", () => {
    const { layer } = setup({ yes: true, listNetwork: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySecretsUnset({ projectRef: Option.none(), names: [] }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySecretsListNetworkError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsListUnexpectedStatusError on GET 503 (empty-args path)", () => {
    const { layer } = setup({ yes: true, listStatus: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySecretsUnset({ projectRef: Option.none(), names: [] }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySecretsListUnexpectedStatusError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsUnsetNetworkError on DELETE transport failure", () => {
    const { layer } = setup({ yes: true, deleteNetwork: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsUnsetNetworkError");
        expect(errJson).toContain("failed to delete secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsUnsetUnexpectedStatusError on DELETE 500", () => {
    const { layer } = setup({ yes: true, deleteStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsUnsetUnexpectedStatusError");
        expect(errJson).toContain("Unexpected error unsetting project secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { project_ref, count } for --output-format=json", () => {
    const { layer, out } = setup({ yes: true, format: "json" });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({
        projectRef: Option.none(),
        names: ["FOO", "BAR"],
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toEqual({ project_ref: VALID_REF, count: 2 });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format=stream-json", () => {
    const { layer, out } = setup({ yes: true, format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "text mode prints `Finished supabase secrets unset.\\n` regardless of --output value",
    () => {
      const { layer } = setup({ yes: true, goOutput: "json" });
      return Effect.gen(function* () {
        yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
        expect(stdoutText()).toBe("Finished supabase secrets unset.\n");
      }).pipe(Effect.provide(layer));
    },
  );
});
