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
import { legacyNetworkBansRemove } from "./remove.handler.ts";

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  legacyOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  status?: number;
  network?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-network-bans-remove-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: null },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.legacyOutput === undefined ? Option.none() : Option.some(opts.legacyOutput),
  });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: null },
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

describe("legacy network-bans remove integration", () => {
  it.live("removes bans and prints the success line in text mode", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacyNetworkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("DELETE");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/network-bans`);
      expect(api.requests[0]?.body).toEqual({ ipv4_addresses: [], requester_ip: true });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends the expected request body when explicit IPs are provided", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyNetworkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: ["12.3.4.5", "2001:db8:abcd:0012::0"],
      });
      expect(api.requests[0]?.body).toEqual({
        ipv4_addresses: ["12.3.4.5", "2001:db8:abcd:0012::0"],
        requester_ip: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores legacy --output values and still prints the success line", () => {
    const { layer, out } = setup({ legacyOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores legacy --output yaml and still prints the success line", () => {
    const { layer, out } = setup({ legacyOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Successfully removed network bans.");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Successfully removed network bans.");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output wins over TS --output-format when both are set", () => {
    const { layer, out } = setup({ format: "json", legacyOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("fails before any API call when an IP is invalid", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkBansRemove({
          projectRef: Option.none(),
          dbUnbanIp: ["12.3.4"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(0);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacyNetworkBansInvalidIpError");
        expect(errJson).toContain("invalid IP address: 12.3.4");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyNetworkBansRemoveUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkBansRemove({
          projectRef: Option.none(),
          dbUnbanIp: [],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacyNetworkBansRemoveUnexpectedStatusError");
        expect(errJson).toContain("unexpected unban status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a network error when the API transport fails", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkBansRemove({
          projectRef: Option.none(),
          dbUnbanIp: [],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacyNetworkBansRemoveNetworkError");
        expect(errJson).toContain("failed to remove network bans:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      yield* legacyNetworkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyNetworkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even on API failure", () => {
    const { layer, telemetry, cache } = setupTracked({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkBansRemove({
          projectRef: Option.none(),
          dbUnbanIp: [],
        }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    });
  });
});
