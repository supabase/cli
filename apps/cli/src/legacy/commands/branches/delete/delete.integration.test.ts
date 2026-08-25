import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliSettings,
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
  const cliSettings = mockLegacyCliSettings({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({ out, api, cliSettings });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: "text" });
  const api = buildApi(opts);
  const cliSettings = mockLegacyCliSettings({ workdir: tempRoot.current });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliSettings,
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

  it.live(
    "resolves a branch NAME against the linked PARENT (not the branch's own ref) after `supabase link <branch>` (CLI-2167 follow-up)",
    () => {
      const PARENT_REF = "parentprojectrefxxxx";
      const BRANCH_OWN_REF = "branchownrefyyyyyyyy";
      const RESOLVED_BRANCH_UUID = "22222222-2222-4222-8222-222222222222";
      // `V1GetABranchOutput` body for the name lookup — its own `project_ref`
      // becomes `branch_id_or_ref` for the subsequent DELETE call, so it must
      // be UUID-shaped (see the oneOf note on `BRANCH_UUID` above).
      const NAME_LOOKUP_BRANCH = {
        id: "33333333-3333-4333-8333-333333333333",
        name: "my-feature",
        project_ref: RESOLVED_BRANCH_UUID,
        parent_project_ref: PARENT_REF,
        is_default: false,
        persistent: false,
        status: "MIGRATIONS_PASSED",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        with_data: false,
      };
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi({
        handler: (request) =>
          Effect.sync(() => {
            if (request.method === "GET" && request.url.includes("/branches/my-feature")) {
              return legacyJsonResponse(request, 200, NAME_LOOKUP_BRANCH);
            }
            if (request.method === "DELETE" && request.url.includes("/v1/branches/")) {
              return legacyJsonResponse(request, 200, { message: "ok" });
            }
            return legacyJsonResponse(request, 200, null);
          }),
      });
      const cliSettings = mockLegacyCliSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
      const layer = buildLegacyTestRuntime({ out, api, cliSettings });
      // Simulate the state left by `supabase link <branch>`: project-ref holds
      // the branch's OWN ref, but linked-project.json still holds the real
      // parent — `branches delete` must resolve the parent for the name
      // lookup, not the branch ref sitting in project-ref.
      mkdirSync(join(tempRoot.current, "supabase", ".temp"), { recursive: true });
      writeFileSync(join(tempRoot.current, "supabase", ".temp", "project-ref"), BRANCH_OWN_REF);
      writeFileSync(
        join(tempRoot.current, "supabase", ".temp", "linked-project.json"),
        JSON.stringify({
          ref: PARENT_REF,
          name: "Parent Project",
          organization_id: "org_1",
          organization_slug: "acme",
        }),
      );
      return Effect.gen(function* () {
        yield* legacyBranchesDelete({ ...baseFlags, name: Option.some("my-feature") });
        const lookup = api.requests.find(
          (r) => r.method === "GET" && r.url.includes("/branches/my-feature"),
        );
        expect(lookup?.url).toContain(`/v1/projects/${PARENT_REF}/branches/my-feature`);
        // The subsequent branch-scoped DELETE is unaffected — it uses whatever
        // ref the name lookup resolved to, not the parent and not the stale
        // branch-own ref from project-ref.
        const del = api.requests.find((r) => r.method === "DELETE");
        expect(del?.url).toContain(`/v1/branches/${RESOLVED_BRANCH_UUID}`);
      }).pipe(Effect.provide(layer));
    },
  );
});
