import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import type { LegacyBranchesPauseFlags } from "./pause.command.ts";
import { legacyBranchesPause } from "./pause.handler.ts";

// 20-lowercase project ref returned by the resolver and forwarded to the
// pause endpoint. Pause/Restore endpoints accept plain project refs, no oneOf.
const BRANCH_REF = "cccccccccccccccccccc";
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";

// Full V1GetABranchConfigOutput body for the resolver's UUID path.
const BRANCH_CONFIG = {
  ref: BRANCH_REF,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "db.cccccccccccccccccccc.supabase.co",
  db_port: 5432,
};

// Full V1GetABranchOutput body for the resolver's named-lookup path.
const BRANCH_NAMED_LOOKUP = {
  id: BRANCH_UUID,
  name: "feat-x",
  project_ref: BRANCH_REF,
  parent_project_ref: LEGACY_VALID_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
};

const tempRoot = useLegacyTempWorkdir("supabase-branches-pause-int-");

interface SetupOpts {
  readonly pauseStatus?: number;
}

function buildApi(opts: SetupOpts) {
  const pauseStatus = opts.pauseStatus ?? 200;
  return mockLegacyPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "POST" && request.url.endsWith("/pause")) {
          return legacyJsonResponse(request, pauseStatus, null);
        }
        // Resolver UUID path: GET /v1/branches/{uuid}
        if (request.method === "GET" && request.url.includes("/v1/branches/")) {
          return legacyJsonResponse(request, 200, BRANCH_CONFIG);
        }
        // Resolver named-lookup path: GET /v1/projects/{ref}/branches/{name}
        if (
          request.method === "GET" &&
          request.url.includes(`/v1/projects/${LEGACY_VALID_REF}/branches/`)
        ) {
          return legacyJsonResponse(request, 200, BRANCH_NAMED_LOOKUP);
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

const baseFlags: LegacyBranchesPauseFlags = {
  name: Option.none(),
  projectRef: Option.none(),
};

describe("legacy branches pause integration", () => {
  it.live("pauses a branch when given a project-ref pattern (skips lookup)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesPause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      const post = api.requests.find((r) => r.method === "POST");
      expect(post?.url).toContain(`/v1/projects/${BRANCH_REF}/pause`);
      // No resolver lookup
      expect(api.requests.find((r) => r.method === "GET")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves a UUID via V1GetABranchConfig and then pauses", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesPause({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(api.requests.some((r) => r.method === "GET" && r.url.includes("/v1/branches/"))).toBe(
        true,
      );
      expect(api.requests.find((r) => r.method === "POST")?.url).toContain(
        `/v1/projects/${BRANCH_REF}/pause`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves a plain name via the project's branches endpoint", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesPause({ ...baseFlags, name: Option.some("feat-x") });
      expect(
        api.requests.some((r) =>
          r.url.includes(`/v1/projects/${LEGACY_VALID_REF}/branches/feat-x`),
        ),
      ).toBe(true);
      expect(api.requests.find((r) => r.method === "POST")?.url).toContain(
        `/v1/projects/${BRANCH_REF}/pause`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("does not emit anything on stdout/stderr on success (silent like Go)", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesPause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesPauseUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ pauseStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesPause({ ...baseFlags, name: Option.some(BRANCH_REF) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesPauseUnexpectedStatusError");
        expect(json).toContain("unexpected pause branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache and telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyBranchesPause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
