import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
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
});
