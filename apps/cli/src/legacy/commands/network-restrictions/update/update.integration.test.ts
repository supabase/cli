import {
  type V1PatchNetworkRestrictionsOutput,
  type V1UpdateNetworkRestrictionsOutput,
} from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  type MockLegacyPlatformApiOpts,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyNetworkRestrictionsUpdate } from "./update.handler.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POST_APPLIED: typeof V1UpdateNetworkRestrictionsOutput.Type = {
  entitlement: "allowed",
  config: {
    dbAllowedCidrs: ["12.3.4.5/32", "1.2.3.1/24"],
    dbAllowedCidrsV6: ["2001:db8:abcd:0012::0/64"],
  },
  status: "applied",
};

const POST_EMPTY_APPLIED: typeof V1UpdateNetworkRestrictionsOutput.Type = {
  entitlement: "allowed",
  config: { dbAllowedCidrs: [], dbAllowedCidrsV6: [] },
  status: "applied",
};

const POST_STORED: typeof V1UpdateNetworkRestrictionsOutput.Type = {
  entitlement: "allowed",
  config: { dbAllowedCidrs: ["1.2.3.0/24"], dbAllowedCidrsV6: [] },
  status: "stored",
};

const PATCH_APPLIED: typeof V1PatchNetworkRestrictionsOutput.Type = {
  entitlement: "allowed",
  config: {
    dbAllowedCidrs: [
      { address: "12.3.4.5/32", type: "v4" },
      { address: "2001:db8:abcd:0012::0/64", type: "v6" },
      { address: "1.2.3.1/24", type: "v4" },
    ],
  },
  status: "applied",
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  postResponse?: typeof V1UpdateNetworkRestrictionsOutput.Type;
  postStatus?: number;
  patchResponse?: typeof V1PatchNetworkRestrictionsOutput.Type;
  patchStatus?: number;
  network?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-network-restrictions-update-int-");

function apiOpts(opts: SetupOpts): MockLegacyPlatformApiOpts {
  return {
    byMethod: {
      POST: { status: opts.postStatus ?? 201, body: opts.postResponse ?? POST_APPLIED },
      PATCH: { status: opts.patchStatus ?? 200, body: opts.patchResponse ?? PATCH_APPLIED },
    },
    network: opts.network,
  };
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi(apiOpts(opts));
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
  const api = mockLegacyPlatformApi(apiOpts(opts));
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

const baseFlags = {
  projectRef: Option.none<string>(),
  dbAllowCidr: [] as readonly string[],
  bypassCidrChecks: false,
  append: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy network-restrictions update integration", () => {
  // -------------------------------------------------------------------------
  // Replace mode (POST /apply)
  // -------------------------------------------------------------------------

  it.live("POSTs /apply with partitioned v4/v6 lists and prints the Go-format block", () => {
    const { layer, out, api } = setup({ postResponse: POST_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({
        ...baseFlags,
        dbAllowCidr: ["12.3.4.5/32", "2001:db8:abcd:0012::0/64", "1.2.3.1/24"],
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/network-restrictions/apply`,
      );
      expect(api.requests[0]?.body).toEqual({
        dbAllowedCidrs: ["12.3.4.5/32", "1.2.3.1/24"],
        dbAllowedCidrsV6: ["2001:db8:abcd:0012::0/64"],
      });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[12.3.4.5/32 1.2.3.1/24]\n" +
          "DB Allowed IPv6 CIDRs: &[2001:db8:abcd:0012::0/64]\n" +
          "Restrictions applied successfully: true\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("sends empty arrays when no --db-allow-cidr is provided", () => {
    const { layer, api } = setup({ postResponse: POST_EMPTY_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate(baseFlags);
      expect(api.requests[0]?.body).toEqual({ dbAllowedCidrs: [], dbAllowedCidrsV6: [] });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "treats `applied successfully` as false when the POST response status is `stored`",
    () => {
      const { layer, out } = setup({ postResponse: POST_STORED });
      return Effect.gen(function* () {
        yield* legacyNetworkRestrictionsUpdate({ ...baseFlags, dbAllowCidr: ["1.2.3.0/24"] });
        expect(out.stdoutText).toBe(
          "DB Allowed IPv4 CIDRs: &[1.2.3.0/24]\n" +
            "DB Allowed IPv6 CIDRs: &[]\n" +
            "Restrictions applied successfully: false\n",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("routes an IPv4-mapped IPv6 input into the v4 request bucket (Go To4 parity)", () => {
    const { layer, api } = setup({
      postResponse: {
        ...POST_EMPTY_APPLIED,
        config: { dbAllowedCidrs: ["::ffff:1.2.3.4/128"], dbAllowedCidrsV6: [] },
      },
    });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({
        ...baseFlags,
        dbAllowCidr: ["::ffff:1.2.3.4/128"],
      });
      expect(api.requests[0]?.body).toEqual({
        dbAllowedCidrs: ["::ffff:1.2.3.4/128"],
        dbAllowedCidrsV6: [],
      });
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Append mode (PATCH /network-restrictions)
  // -------------------------------------------------------------------------

  it.live("PATCHes when --append=true with `add` payload and partitions the V2 response", () => {
    const { layer, out, api } = setup({ patchResponse: PATCH_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({
        ...baseFlags,
        append: true,
        dbAllowCidr: ["12.3.4.5/32", "1.2.3.1/24", "2001:db8:abcd:0012::0/64"],
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("PATCH");
      expect(api.requests[0]?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/network-restrictions`,
      );
      expect(api.requests[0]?.url).not.toContain("/apply");
      expect(api.requests[0]?.body).toEqual({
        add: {
          dbAllowedCidrs: ["12.3.4.5/32", "1.2.3.1/24"],
          dbAllowedCidrsV6: ["2001:db8:abcd:0012::0/64"],
        },
      });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[12.3.4.5/32 1.2.3.1/24]\n" +
          "DB Allowed IPv6 CIDRs: &[2001:db8:abcd:0012::0/64]\n" +
          "Restrictions applied successfully: true\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("prints `&[]` for both arrays when the PATCH response has no matching items", () => {
    const empty: typeof V1PatchNetworkRestrictionsOutput.Type = {
      entitlement: "allowed",
      config: {},
      status: "applied",
    };
    const { layer, out } = setup({ patchResponse: empty });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({ ...baseFlags, append: true });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[]\n" +
          "DB Allowed IPv6 CIDRs: &[]\n" +
          "Restrictions applied successfully: true\n",
      );
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // CIDR validation
  // -------------------------------------------------------------------------

  it.live("rejects an input missing the /mask suffix with Go's verbatim message", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkRestrictionsUpdate({
          ...baseFlags,
          dbAllowCidr: ["12.3.4.5", "10.0.0.0/8", "1.2.3.1/24"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyNetworkRestrictionsInvalidCidrError");
        expect(errorJson).toContain("failed to parse IP: 12.3.4.5");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects an RFC-1918 private IPv4 input with Go's verbatim message", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkRestrictionsUpdate({
          ...baseFlags,
          dbAllowCidr: ["12.3.4.5/32", "10.0.0.0/8", "1.2.3.1/24"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyNetworkRestrictionsPrivateIpError");
        expect(errorJson).toContain("private IP provided: 10.0.0.0/8");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects an IPv4-mapped private IPv6 input (security regression guard)", () => {
    // Without IPv4-mapped detection, ::ffff:10.0.0.0/104 would slip past the
    // private check because the IPv6 first-byte is 0, not 0xfc. parseCidr now
    // reclassifies these as v4 via Go's To4() semantics; the v4 path catches
    // 10.0.0.0/8.
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkRestrictionsUpdate({
          ...baseFlags,
          dbAllowCidr: ["::ffff:10.0.0.0/104"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyNetworkRestrictionsPrivateIpError");
        expect(errorJson).toContain("private IP provided: ::ffff:10.0.0.0/104");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("does NOT call the API when CIDR validation fails", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* Effect.exit(
        legacyNetworkRestrictionsUpdate({
          ...baseFlags,
          dbAllowCidr: ["12.3.4.5"],
        }),
      );
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes private inputs through to the API when --bypass-cidr-checks=true", () => {
    const { layer, api } = setup({
      postResponse: {
        ...POST_EMPTY_APPLIED,
        config: { dbAllowedCidrs: ["10.0.0.0/8"], dbAllowedCidrsV6: [] },
      },
    });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({
        ...baseFlags,
        bypassCidrChecks: true,
        dbAllowCidr: ["10.0.0.0/8"],
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.body).toEqual({
        dbAllowedCidrs: ["10.0.0.0/8"],
        dbAllowedCidrsV6: [],
      });
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // HTTP error mapping
  // -------------------------------------------------------------------------

  it.live("reports a Go-compatible error message when the POST network is unreachable", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyNetworkRestrictionsUpdate(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyNetworkRestrictionsUpdateNetworkError");
        expect(errorJson).toContain("failed to apply network restrictions:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a Go-compatible error message when the POST returns 503", () => {
    const { layer } = setup({ postStatus: 503, postResponse: POST_EMPTY_APPLIED });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyNetworkRestrictionsUpdate(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyNetworkRestrictionsUpdateUnexpectedStatusError");
        expect(errorJson).toContain("failed to apply network restrictions:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a Go-compatible error message when the PATCH network is unreachable", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkRestrictionsUpdate({ ...baseFlags, append: true }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyNetworkRestrictionsUpdateNetworkError");
        expect(errorJson).toContain("failed to apply network restrictions:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a Go-compatible error message when the PATCH returns a non-200 status", () => {
    const { layer } = setup({ patchStatus: 500, patchResponse: PATCH_APPLIED });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkRestrictionsUpdate({ ...baseFlags, append: true }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyNetworkRestrictionsUpdateUnexpectedStatusError");
        expect(errorJson).toContain("failed to apply network restrictions:");
      }
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Output modes — POST
  // -------------------------------------------------------------------------

  it.live("emits a structured JSON success payload via --output-format=json after POST", () => {
    const { layer, out } = setup({ format: "json", postResponse: POST_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({
        ...baseFlags,
        dbAllowCidr: ["12.3.4.5/32"],
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ status: "applied" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event via --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", postResponse: POST_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ status: "applied" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible JSON when --output=json after POST", () => {
    const { layer, out } = setup({ goOutput: "json", postResponse: POST_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate(baseFlags);
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stdoutText).toContain('"status": "applied"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible YAML when --output=yaml after POST", () => {
    const { layer, out } = setup({ goOutput: "yaml", postResponse: POST_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate(baseFlags);
      expect(out.stdoutText).toContain("status: applied");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible TOML when --output=toml after POST", () => {
    const { layer, out } = setup({ goOutput: "toml", postResponse: POST_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate(baseFlags);
      expect(out.stdoutText).toContain("status = ");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible env output when --output=env after POST", () => {
    const { layer, out } = setup({ goOutput: "env", postResponse: POST_EMPTY_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate(baseFlags);
      expect(out.stdoutText).toContain('STATUS="applied"');
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty identically to text mode", () => {
    const { layer, out } = setup({ goOutput: "pretty", postResponse: POST_EMPTY_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate(baseFlags);
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[]\n" +
          "DB Allowed IPv6 CIDRs: &[]\n" +
          "Restrictions applied successfully: true\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output wins over TS --output-format after POST when both are set", () => {
    const { layer, out } = setup({
      format: "json",
      goOutput: "yaml",
      postResponse: POST_APPLIED,
    });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate(baseFlags);
      expect(out.stdoutText.startsWith("{")).toBe(false);
      expect(out.stdoutText).toContain("status: applied");
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Output modes — PATCH (cover encoders against V2 response shape)
  // -------------------------------------------------------------------------

  it.live("emits a structured JSON success payload via --output-format=json after PATCH", () => {
    const { layer, out } = setup({ format: "json", patchResponse: PATCH_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({
        ...baseFlags,
        append: true,
        dbAllowCidr: ["12.3.4.5/32"],
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ status: "applied" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible JSON when --output=json after PATCH", () => {
    const { layer, out } = setup({ goOutput: "json", patchResponse: PATCH_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({ ...baseFlags, append: true });
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stdoutText).toContain('"status": "applied"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible YAML when --output=yaml after PATCH", () => {
    const { layer, out } = setup({ goOutput: "yaml", patchResponse: PATCH_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({ ...baseFlags, append: true });
      expect(out.stdoutText).toContain("status: applied");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible TOML when --output=toml after PATCH", () => {
    const { layer, out } = setup({ goOutput: "toml", patchResponse: PATCH_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({ ...baseFlags, append: true });
      expect(out.stdoutText).toContain("status = ");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible env output when --output=env after PATCH", () => {
    const { layer, out } = setup({
      goOutput: "env",
      patchResponse: {
        entitlement: "allowed",
        config: {},
        status: "applied",
      },
    });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({ ...baseFlags, append: true });
      expect(out.stdoutText).toContain('STATUS="applied"');
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output wins over TS --output-format after PATCH when both are set", () => {
    const { layer, out } = setup({
      format: "json",
      goOutput: "yaml",
      patchResponse: PATCH_APPLIED,
    });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({ ...baseFlags, append: true });
      expect(out.stdoutText.startsWith("{")).toBe(false);
      expect(out.stdoutText).toContain("status: applied");
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Project ref resolution
  // -------------------------------------------------------------------------

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ postResponse: POST_EMPTY_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate({
        ...baseFlags,
        projectRef: Option.some(flagRef),
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a malformed resolved project ref before issuing any HTTP call", () => {
    const { layer } = setup({ postResponse: POST_EMPTY_APPLIED });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkRestrictionsUpdate({
          ...baseFlags,
          projectRef: Option.some("BADREF"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
      }
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // withJsonErrorHandling
  // -------------------------------------------------------------------------

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({
      format: "json",
      postStatus: 503,
      postResponse: POST_EMPTY_APPLIED,
    });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate(baseFlags).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // PersistentPostRun parity (telemetry + linked-project cache)
  // -------------------------------------------------------------------------

  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setupTracked({ postResponse: POST_APPLIED });
    return Effect.gen(function* () {
      yield* legacyNetworkRestrictionsUpdate(baseFlags);
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry on CIDR validation failure (before any HTTP call)", () => {
    const { layer, telemetry, cache, api } = setupTracked();
    return Effect.gen(function* () {
      yield* Effect.exit(legacyNetworkRestrictionsUpdate({ ...baseFlags, dbAllowCidr: ["bad"] }));
      // Telemetry is the outermost ensuring, so it always fires.
      expect(telemetry.flushed).toBe(true);
      // Linked-project cache is inside the ref-resolved scope; CIDR validation
      // short-circuits before the ref is resolved, so it must not fire.
      expect(cache.cached).toBe(false);
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry on API failure", () => {
    const { layer, telemetry, cache } = setupTracked({
      postStatus: 500,
      postResponse: POST_EMPTY_APPLIED,
    });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyNetworkRestrictionsUpdate(baseFlags));
      expect(telemetry.flushed).toBe(true);
      // Ref resolved successfully, so cache fires even though the API failed.
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
