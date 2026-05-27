import { type V1GetNetworkRestrictionsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyNetworkRestrictionsGet } from "./get.handler.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPLIED_WITH_CIDRS: typeof V1GetNetworkRestrictionsOutput.Type = {
  entitlement: "allowed",
  config: {
    dbAllowedCidrs: ["1.2.3.0/24", "5.6.7.0/24"],
    dbAllowedCidrsV6: ["2001:db8::/64"],
  },
  status: "applied",
};

const APPLIED_NO_CIDRS: typeof V1GetNetworkRestrictionsOutput.Type = {
  entitlement: "allowed",
  config: { dbAllowedCidrs: [], dbAllowedCidrsV6: [] },
  status: "applied",
};

const STORED_WITH_OMITTED_CIDRS: typeof V1GetNetworkRestrictionsOutput.Type = {
  entitlement: "allowed",
  config: {},
  status: "stored",
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1GetNetworkRestrictionsOutput.Type;
  status?: number;
  network?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-network-restrictions-get-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? APPLIED_WITH_CIDRS },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? APPLIED_WITH_CIDRS },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, telemetry, cache };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy network-restrictions get integration", () => {
  it.live("prints the Go-format text block when the response has v4 and v6 entries", () => {
    const { layer, out } = setup({ response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[1.2.3.0/24 5.6.7.0/24]\n" +
          "DB Allowed IPv6 CIDRs: &[2001:db8::/64]\n" +
          "Restrictions applied successfully: true\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("prints `&[]` for both arrays when the API returns empty arrays", () => {
    const { layer, out } = setup({ response: APPLIED_NO_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[]\n" +
          "DB Allowed IPv6 CIDRs: &[]\n" +
          "Restrictions applied successfully: true\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("prints `<nil>` when the API omits the dbAllowedCidrs fields", () => {
    const { layer, out } = setup({ response: STORED_WITH_OMITTED_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: <nil>\n" +
          "DB Allowed IPv6 CIDRs: <nil>\n" +
          "Restrictions applied successfully: false\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("prints `Restrictions applied successfully: false` when status is `stored`", () => {
    const stored: typeof V1GetNetworkRestrictionsOutput.Type = {
      entitlement: "allowed",
      config: { dbAllowedCidrs: ["1.2.3.0/24"], dbAllowedCidrsV6: [] },
      status: "stored",
    };
    const { layer, out } = setup({ response: stored });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[1.2.3.0/24]\n" +
          "DB Allowed IPv6 CIDRs: &[]\n" +
          "Restrictions applied successfully: false\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured JSON success payload via --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        status: "applied",
        config: {
          dbAllowedCidrs: ["1.2.3.0/24", "5.6.7.0/24"],
          dbAllowedCidrsV6: ["2001:db8::/64"],
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event via --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ status: "applied" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible JSON when --output=json", () => {
    const { layer, out } = setup({ goOutput: "json", response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stdoutText.endsWith("\n")).toBe(true);
      expect(out.stdoutText).toContain('"status": "applied"');
      expect(out.stdoutText).toContain('"dbAllowedCidrs"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible YAML when --output=yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml", response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("status: applied");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible TOML when --output=toml", () => {
    const { layer, out } = setup({ goOutput: "toml", response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("status = ");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible env output when --output=env", () => {
    const { layer, out } = setup({ goOutput: "env", response: APPLIED_NO_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('STATUS="applied"');
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty identically to text mode", () => {
    const { layer, out } = setup({ goOutput: "pretty", response: APPLIED_NO_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[]\n" +
          "DB Allowed IPv6 CIDRs: &[]\n" +
          "Restrictions applied successfully: true\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output wins over TS --output-format when both are set", () => {
    const { layer, out } = setup({
      format: "json",
      goOutput: "yaml",
      response: APPLIED_WITH_CIDRS,
    });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(out.stdoutText.startsWith("{")).toBe(false);
      expect(out.stdoutText).toContain("status: applied");
    }).pipe(Effect.provide(layer));
  });

  it.live("hits the GET /v1/projects/{ref}/network-restrictions URL", () => {
    const { layer, api } = setup({ response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/network-restrictions`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a Go-compatible error message when the API returns a non-200 status", () => {
    const { layer } = setup({ status: 503, response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyNetworkRestrictionsGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyNetworkRestrictionsGetUnexpectedStatusError");
        expect(errorJson).toContain("failed to retrieve network restrictions; received:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a Go-compatible error message when the network is unreachable", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyNetworkRestrictionsGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyNetworkRestrictionsGetNetworkError");
        expect(errorJson).toContain("failed to retrieve network restrictions:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() }).pipe(
        withJsonErrorHandling,
      );
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setupTracked({ response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsGet({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even on API failure", () => {
    const { layer, telemetry, cache } = setupTracked({
      status: 500,
      response: APPLIED_WITH_CIDRS,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkRestrictionsGet({ projectRef: Option.none() }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      // Linked-project cache wraps the inner effect, so it still fires after ref
      // resolution succeeded — matches Go's PersistentPostRun once ref is known.
      expect(cache.cached).toBe(true);
    });
  });
});
