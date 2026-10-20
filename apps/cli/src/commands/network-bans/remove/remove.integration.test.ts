import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { networkBansRemoveDbUnbanIpFlag } from "./remove.command.ts";
import { networkBansRemove } from "./remove.handler.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

// Runs the real --db-unban-ip flag pipeline so these scenarios cover raw CLI values
// through to the request body.
const parseDbUnbanIp = (rawValues: ReadonlyArray<string>) =>
  networkBansRemoveDbUnbanIpFlag.parse({ flags: { "db-unban-ip": rawValues }, arguments: [] }).pipe(
    Effect.map(([, values]) => values),
    Effect.provide(BunServices.layer),
  );

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml";
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
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
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

describe("network-bans remove integration", () => {
  it.effect("removes bans and prints the success line in text mode", () => {
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
      assertPermissionDrift({
        command: "network-bans remove",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the picker's projects, removes the bans and fills the real cache", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.url === "https://api.supabase.com/v1/projects") {
          return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
        }
        if (request.url === `https://api.supabase.com/v1/projects/${VALID_REF}`) {
          return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
        }
        return Effect.succeed(jsonResponse(request, 200, null));
      },
    });
    const cliSettings = mockCommandSettings({
      workdir: tempRoot.current,
      projectId: Option.none(),
    });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings,
      tty: mockTty({ stdinIsTty: true }),
      linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* networkBansRemove({ projectRef: Option.none(), dbUnbanIp: [] });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `DELETE https://api.supabase.com/v1/projects/${VALID_REF}/network-bans`,
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "network-bans remove",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends the expected request body when explicit IPs are provided", () => {
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
      assertPermissionDrift({
        command: "network-bans remove",
        activeFlags: { "db-unban-ip": true },
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("unbans every IP in a comma-separated --db-unban-ip value", () => {
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

  it.effect("appends IPs across repeated --db-unban-ip flags", () => {
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

  it.effect("combines comma-separated and repeated --db-unban-ip occurrences", () => {
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

  it.effect("still unbans a single --db-unban-ip value", () => {
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

  it.effect("rejects an invalid IP produced by a comma split before any API call", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const dbUnbanIp = yield* parseDbUnbanIp(["12.3.4.5,notanip"]);
      const exit = yield* Effect.exit(networkBansRemove({ projectRef: Option.none(), dbUnbanIp }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(0);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("invalid IP address: notanip");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("ignores --output values and still prints the success line", () => {
    const { layer, out } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* networkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("ignores --output yaml and still prints the success line", () => {
    const { layer, out } = setup({ outputFlag: "yaml" });
    return Effect.gen(function* () {
      yield* networkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a JSON success event for --output-format=json", () => {
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

  it.effect("emits a result event for --output-format=stream-json", () => {
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

  it.effect("--output wins over --output-format when both are set", () => {
    const { layer, out } = setup({ format: "json", outputFlag: "yaml" });
    return Effect.gen(function* () {
      yield* networkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      });
      expect(out.stdoutText).toBe("Successfully removed network bans.\n");
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails before any API call when an IP is invalid", () => {
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
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("NetworkBansInvalidIpError");
        expect(causeText).toContain("invalid IP address: 12.3.4");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "surfaces the unresolved-ref error, not the invalid-IP error, when both are wrong",
    () => {
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
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("ProjectRefNotLinkedError");
          expect(causeText).not.toContain("NetworkBansInvalidIpError");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
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
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("InvalidProjectRefError");
          expect(causeText).not.toContain("NetworkBansInvalidIpError");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("fails with NetworkBansRemoveUnexpectedStatusError on HTTP 503", () => {
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
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("NetworkBansRemoveUnexpectedStatusError");
        expect(causeText).toContain("unexpected unban status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a network error when the API transport fails", () => {
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
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("NetworkBansRemoveNetworkError");
        expect(causeText).toContain("failed to remove network bans:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      yield* networkBansRemove({
        projectRef: Option.none(),
        dbUnbanIp: [],
      }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry and writes linked-project cache on success", () => {
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

  it.effect("flushes telemetry even on API failure", () => {
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
