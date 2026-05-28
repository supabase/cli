import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import type { LegacyBranchesDeleteFlags } from "./delete.command.ts";
import { legacyBranchesDelete } from "./delete.handler.ts";

// V1DeleteABranchInput.branch_id_or_ref is a oneOf [project-ref, uuid] union.
// A 20-lowercase project ref matches BOTH branches → schema rejects.
// Tests pass a v4 UUID so the schema picks exactly one branch.
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";

// V1GetABranchConfigOutput body — used by the resolver's UUID path. The
// returned `ref` becomes the `branch_id_or_ref` for the DELETE call, so it
// must be UUID-shaped.
const BRANCH_CONFIG = {
  ref: BRANCH_UUID,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "h",
  db_port: 5432,
};

const tempRoot = useLegacyTempWorkdir("supabase-branches-delete-int-");

interface SetupOpts {
  readonly deleteStatus?: number;
}

function buildApi(opts: SetupOpts) {
  const deleteStatus = opts.deleteStatus ?? 200;
  return mockLegacyPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "DELETE" && request.url.includes("/v1/branches/")) {
          return legacyJsonResponse(
            request,
            deleteStatus,
            deleteStatus === 200 ? { message: "ok" } : {},
          );
        }
        if (request.method === "GET" && request.url.includes("/v1/branches/")) {
          return legacyJsonResponse(request, 200, BRANCH_CONFIG);
        }
        return legacyJsonResponse(request, 200, null);
      }),
  });
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: "text" });
  const api = buildApi(opts);
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({ out, api, cliConfig });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: "text" });
  const api = buildApi(opts);
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

const baseFlags: LegacyBranchesDeleteFlags = {
  name: Option.none(),
  projectRef: Option.none(),
};

describe("legacy branches delete integration", () => {
  it.live("deletes a branch and emits 'Deleted preview branch: <ref>' to stderr", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(out.stderrText).toContain(`Deleted preview branch: ${BRANCH_UUID}`);
      expect(api.requests.find((r) => r.method === "DELETE")?.url).toContain(
        `/v1/branches/${BRANCH_UUID}`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("omits the force query param (Go passes nil)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      const del = api.requests.find((r) => r.method === "DELETE");
      expect(del?.url).not.toContain("force=");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesDeleteUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ deleteStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesDeleteUnexpectedStatusError");
        expect(json).toContain("unexpected delete branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyBranchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on failure", () => {
    const { layer, telemetry, cache } = setupTracked({ deleteStatus: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyBranchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
