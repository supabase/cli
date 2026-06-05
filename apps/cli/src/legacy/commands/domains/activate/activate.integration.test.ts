import { type V1GetHostnameConfigOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyDomainsActivate } from "./activate.handler.ts";

const HOSTNAME_RESPONSE: typeof V1GetHostnameConfigOutput.Type = {
  status: "5_services_reconfigured",
  custom_hostname: "shop.acme.dev",
  data: {
    success: true,
    errors: [],
    messages: [],
    result: {
      id: "id-1",
      hostname: "shop.acme.dev",
      ssl: { status: "active", validation_records: [] },
      ownership_verification: { type: "txt", name: "n", value: "v" },
      custom_origin_server: "abc.supabase.co",
      status: "active",
    },
  },
};

type GoOutput = "env" | "pretty" | "json" | "toml" | "yaml";

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: GoOutput;
  readonly status?: number;
  readonly network?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-domains-activate-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 201, body: HOSTNAME_RESPONSE },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: linkedProjectCache.layer,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api, telemetry, linkedProjectCache };
}

const baseFlags = { projectRef: Option.none<string>(), includeRawOutput: false };

describe("legacy domains activate integration", () => {
  it.live("prints the completion status to stderr in text mode", () => {
    const { layer, out, api, telemetry, linkedProjectCache } = setup();
    return Effect.gen(function* () {
      yield* legacyDomainsActivate(baseFlags);
      expect(out.stderrText).toContain(
        "Custom hostname setup completed. Project is now accessible at shop.acme.dev.",
      );
      expect(out.stdoutText).toBe("");
      expect(api.requests[0]?.url).toContain("/custom-hostname/activate");
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured success object for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyDomainsActivate(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ status: "5_services_reconfigured" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits indented Go JSON to stdout for -o json", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyDomainsActivate(baseFlags);
      expect(out.stdoutText.startsWith("{")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("forces Go JSON output when --include-raw-output is set", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyDomainsActivate({ projectRef: Option.none(), includeRawOutput: true });
      expect(out.stdoutText.startsWith("{")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyDomainsUnexpectedStatusError on HTTP 503", () => {
    const { layer, telemetry } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsActivate(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("unexpected activate hostname status 503");
      }
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyDomainsNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsActivate(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to activate custom hostname");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps an HTTP error without a spinner in json mode", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsActivate(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.progressEvents).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
