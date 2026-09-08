import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { networkBansRemoveDbUnbanIpFlag } from "./remove.command.ts";
import { networkBansRemove } from "./remove.handler.ts";

// Runs the real `--db-unban-ip` flag pipeline (pflag StringSlice CSV parity —
// `cmd/bans.go:48`) so these scenarios cover raw CLI values → request body.
const parseDbUnbanIp = (rawValues: ReadonlyArray<string>) =>
  networkBansRemoveDbUnbanIpFlag.parse({ flags: { "db-unban-ip": rawValues }, arguments: [] }).pipe(
    Effect.map(([, values]) => values),
    Effect.provide(BunServices.layer),
  );

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  status?: number;
  network?: "fail";
}

const tempRoot = useTempWorkdir("supabase-network-bans-remove-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: null },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: null },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, telemetry, cache };
}

describe("legacy network-bans remove integration", () => {
  it.live("removes bans and prints the success line in text mode", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* networkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("DELETE");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/network-bans`);
      expect(api.requests[0]?.body).toEqual({ ipv4_addresses: [], requester_ip: true });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends the expected request body when explicit IPs are provided", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* networkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: ["12.3.4.5", "2001:db8:abcd:0012::0"],
      });
      expect(api.requests[0]?.body).toEqual({
        ipv4_addresses: ["12.3.4.5", "2001:db8:abcd:0012::0"],
        requester_ip: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("unbans every IP in a comma-separated --db-unban-ip value (pflag CSV parity)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const dbUnbanIp = yield* parseDbUnbanIp(["12.3.4.5,5.6.7.8"]);
      yield* networkBansRemove({ projectRef: Option.none(), dbUnbanIp });
      expect(api.requests[0]?.body).toEqual({
        ipv4_addresses: ["12.3.4.5", "5.6.7.8"],
        requester_ip: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("appends IPs across repeated --db-unban-ip flags", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const dbUnbanIp = yield* parseDbUnbanIp(["12.3.4.5", "5.6.7.8"]);
      yield* networkBansRemove({ projectRef: Option.none(), dbUnbanIp });
      expect(api.requests[0]?.body).toEqual({
        ipv4_addresses: ["12.3.4.5", "5.6.7.8"],
        requester_ip: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("combines comma-separated and repeated --db-unban-ip occurrences", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const dbUnbanIp = yield* parseDbUnbanIp(["12.3.4.5,5.6.7.8", "9.9.9.9"]);
      yield* networkBansRemove({ projectRef: Option.none(), dbUnbanIp });
      expect(api.requests[0]?.body).toEqual({
        ipv4_addresses: ["12.3.4.5", "5.6.7.8", "9.9.9.9"],
        requester_ip: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("still unbans a single --db-unban-ip value", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const dbUnbanIp = yield* parseDbUnbanIp(["12.3.4.5"]);
      yield* networkBansRemove({ projectRef: Option.none(), dbUnbanIp });
      expect(api.requests[0]?.body).toEqual({
        ipv4_addresses: ["12.3.4.5"],
        requester_ip: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects an invalid IP produced by a comma split before any API call", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const dbUnbanIp = yield* parseDbUnbanIp(["12.3.4.5,notanip"]);
      const exit = yield* Effect.exit(networkBansRemove({ projectRef: Option.none(), dbUnbanIp }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(0);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("invalid IP address: notanip");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores legacy --output values and still prints the success line", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* networkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores legacy --output yaml and still prints the success line", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* networkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* networkBansRemove({
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
      yield* networkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Successfully removed network bans.");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output wins over TS --output-format when both are set", () => {
    const { layer, out } = setup({ format: "json", goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* networkBansRemove({
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
        networkBansRemove({
          projectRef: Option.none(),
          dbUnbanIp: ["12.3.4"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(0);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("NetworkBansInvalidIpError");
        expect(errJson).toContain("invalid IP address: 12.3.4");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "surfaces the unresolved-ref error, not the invalid-IP error, when both are wrong",
    () => {
      // Go resolves the project ref in PersistentPreRunE, before RunE's IP
      // validation ever runs (cmd/root.go:108-114 vs internal/bans/update/update.go:12-25),
      // so a bad ref must win over a bad IP — this is the regression CLI-1856 guards.
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
      const cliSettings = mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
      const layer = buildTestRuntime({ out, api, cliSettings });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          networkBansRemove({
            projectRef: Option.none(),
            dbUnbanIp: ["12.3.4"],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(api.requests).toHaveLength(0);
        if (Exit.isFailure(exit)) {
          const errJson = JSON.stringify(exit.cause);
          expect(errJson).toContain("ProjectRefNotLinkedError");
          expect(errJson).not.toContain("NetworkBansInvalidIpError");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "surfaces the invalid-project-ref error, not the invalid-IP error, when both are wrong",
    () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          networkBansRemove({
            projectRef: Option.some("BADREF"),
            dbUnbanIp: ["12.3.4"],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(api.requests).toHaveLength(0);
        if (Exit.isFailure(exit)) {
          const errJson = JSON.stringify(exit.cause);
          expect(errJson).toContain("InvalidProjectRefError");
          expect(errJson).not.toContain("NetworkBansInvalidIpError");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails with NetworkBansRemoveUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        networkBansRemove({
          projectRef: Option.none(),
          dbUnbanIp: [],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("NetworkBansRemoveUnexpectedStatusError");
        expect(errJson).toContain("unexpected unban status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a network error when the API transport fails", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        networkBansRemove({
          projectRef: Option.none(),
          dbUnbanIp: [],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("NetworkBansRemoveNetworkError");
        expect(errJson).toContain("failed to remove network bans:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      yield* networkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* networkBansRemove({
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
        networkBansRemove({
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
