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
import { legacyDomainsGet } from "./get.handler.ts";

const HOSTNAME_RESPONSE: typeof V1GetHostnameConfigOutput.Type = {
  status: "1_not_started",
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
  readonly response?: typeof V1GetHostnameConfigOutput.Type;
}

const tempRoot = useLegacyTempWorkdir("supabase-domains-get-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? HOSTNAME_RESPONSE },
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

describe("legacy domains get integration", () => {
  it.live("prints the hostname status to stderr in text mode", () => {
    const { layer, out, telemetry, linkedProjectCache } = setup();
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      expect(out.stderrText).toContain("Custom hostname configuration not started.");
      expect(out.stdoutText).toBe("");
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured success object for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ custom_hostname: "shop.acme.dev" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured success object for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits indented Go JSON to stdout with no status on stderr for -o json", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stdoutText).toContain('"custom_hostname": "shop.acme.dev"');
      // Structured -o output: human status is suppressed (Go's no-newline status
      // is fused with + stripped alongside its version-update notice — see emit).
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("backfills Go zero values in JSON output when the API omits nested fields", () => {
    const {
      ownership_verification: _ownershipVerification,
      ...resultWithoutOwnershipVerification
    } = HOSTNAME_RESPONSE.data.result;
    const response: typeof V1GetHostnameConfigOutput.Type = {
      ...HOSTNAME_RESPONSE,
      data: {
        ...HOSTNAME_RESPONSE.data,
        result: {
          ...resultWithoutOwnershipVerification,
          ssl: { status: "pending_validation" },
        },
      },
    };
    const { layer, out } = setup({ goOutput: "json", response });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      const parsed = JSON.parse(out.stdoutText) as typeof V1GetHostnameConfigOutput.Type;
      expect(parsed.data.result.ownership_verification).toEqual({ type: "", name: "", value: "" });
      expect(parsed.data.result.ssl.validation_records).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("backfills Go zero values in JSON output when the API omits envelope fields", () => {
    const {
      status: _status,
      custom_hostname: _customHostname,
      ...responseWithoutEnvelope
    } = HOSTNAME_RESPONSE;
    const {
      ownership_verification: _ownershipVerification,
      ...resultWithoutOwnershipVerification
    } = HOSTNAME_RESPONSE.data.result;
    const response: typeof V1GetHostnameConfigOutput.Type = {
      ...responseWithoutEnvelope,
      data: {
        ...HOSTNAME_RESPONSE.data,
        result: {
          ...resultWithoutOwnershipVerification,
          ssl: { status: "initializing" },
          status: "pending",
        },
      },
    };
    const { layer, out } = setup({ goOutput: "json", response });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      const parsed = JSON.parse(out.stdoutText) as Record<string, unknown>;
      expect(parsed.status).toBe("");
      expect(parsed.custom_hostname).toBe("");
      expect(parsed.data).toMatchObject({
        result: {
          ownership_verification: { type: "", name: "", value: "" },
          ssl: { status: "initializing", validation_records: [] },
          status: "pending",
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("prints processing guidance in text mode when the API omits envelope fields", () => {
    const {
      status: _status,
      custom_hostname: _customHostname,
      ...responseWithoutEnvelope
    } = HOSTNAME_RESPONSE;
    const response: typeof V1GetHostnameConfigOutput.Type = {
      ...responseWithoutEnvelope,
      data: {
        ...HOSTNAME_RESPONSE.data,
        result: {
          ...HOSTNAME_RESPONSE.data.result,
          ssl: { status: "initializing" },
          status: "pending",
        },
      },
    };
    const { layer, out } = setup({ response });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      expect(out.stderrText).toBe(
        "Custom hostname setup is being initialized; please request re-verification in a few seconds.\n",
      );
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("prints outstanding ACME validation records in text mode", () => {
    const response: typeof V1GetHostnameConfigOutput.Type = {
      status: "2_initiated",
      custom_hostname: "sbstg4.thewheatfield.org",
      data: {
        success: true,
        errors: [],
        messages: [],
        result: {
          id: "bd8d3485-bcfb-41cd-a094-ccec2af6be48",
          hostname: "sbstg4.thewheatfield.org",
          ownership_verification: { name: "", type: "", value: "" },
          custom_origin_server: "coekrxjvyzzhmchfbwzr.supabase.red",
          status: "active",
          ssl: {
            status: "pending_validation",
            validation_records: [
              {
                txt_name: "_acme-challenge.sbstg4.thewheatfield.org",
                txt_value: "i6XyXv3kU4SRX9YcCE8h4LExoHE6y_poV1-5R1cjpk4",
              },
            ],
          },
        },
      },
    };
    const { layer, out } = setup({ response });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      expect(out.stderrText).toBe(
        "Custom hostname verification in-progress; please configure the appropriate DNS entries and request re-verification.\n" +
          "Required outstanding validation records:\n" +
          "\t_acme-challenge.sbstg4.thewheatfield.org TXT -> i6XyXv3kU4SRX9YcCE8h4LExoHE6y_poV1-5R1cjpk4\n",
      );
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits YAML to stdout for -o yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      expect(out.stdoutText).toContain("custom_hostname: shop.acme.dev");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits TOML to stdout for -o toml", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      expect(out.stdoutText).toContain('custom_hostname = "shop.acme.dev"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits KEY=VALUE lines for -o env", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      expect(out.stdoutText).toContain('CUSTOM_HOSTNAME="shop.acme.dev"');
    }).pipe(Effect.provide(layer));
  });

  it.live("treats -o pretty as text mode (status to stderr only)", () => {
    const { layer, out } = setup({ goOutput: "pretty" });
    return Effect.gen(function* () {
      yield* legacyDomainsGet(baseFlags);
      expect(out.stderrText).toContain("Custom hostname configuration not started.");
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("forces Go JSON output when --include-raw-output is set", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyDomainsGet({ projectRef: Option.none(), includeRawOutput: true });
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stdoutText).toContain('"custom_hostname": "shop.acme.dev"');
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "forces Go JSON even when -o is explicitly pretty and --include-raw-output is set",
    () => {
      const { layer, out } = setup({ goOutput: "pretty" });
      return Effect.gen(function* () {
        yield* legacyDomainsGet({ projectRef: Option.none(), includeRawOutput: true });
        expect(out.stdoutText.startsWith("{")).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails with LegacyDomainsUnexpectedStatusError on HTTP 503", () => {
    const { layer, telemetry, linkedProjectCache } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsGet(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyDomainsUnexpectedStatusError");
        expect(json).toContain("unexpected get hostname status 503");
      }
      // PersistentPostRun still fires on failure.
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("maps an HTTP error without a spinner in json mode", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsGet(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      // No spinner task is started in json mode.
      expect(out.progressEvents).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyDomainsNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsGet(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyDomainsNetworkError");
        expect(json).toContain("failed to get custom hostname");
      }
    }).pipe(Effect.provide(layer));
  });
});
