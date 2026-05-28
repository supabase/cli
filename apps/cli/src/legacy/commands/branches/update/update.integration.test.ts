import { type V1UpdateABranchConfigOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockAnalytics, mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  legacyJsonResponse,
  legacyStatusCodeFailure,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import type { LegacyBranchesUpdateFlags } from "./update.command.ts";
import { legacyBranchesUpdate } from "./update.handler.ts";

type UpdatedBranch = typeof V1UpdateABranchConfigOutput.Type;

// V1UpdateABranchConfigInput.branch_id_or_ref is a oneOf [project-ref, uuid] union.
// A 20-lowercase project ref matches BOTH branches → schema rejects.
// HTTP-level mock tests pass a v4 UUID so the schema picks exactly one branch.
// The upgrade-suggest test uses `mockLegacyPlatformApiService` to bypass schema
// validation entirely so it can exercise the production-shape branchRef path.
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";
const BRANCH_REF = "cccccccccccccccccccc";

const UPDATED: UpdatedBranch = {
  id: BRANCH_UUID,
  name: "renamed",
  project_ref: BRANCH_REF,
  parent_project_ref: "bbbbbbbbbbbbbbbbbbbb",
  is_default: false,
  persistent: true,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
};

const ORG_SLUG = "test-org";

function projectResponse(ref: string = BRANCH_REF) {
  return {
    id: ref,
    ref,
    organization_id: "org",
    organization_slug: ORG_SLUG,
    name: "Test",
    region: "us-east-1",
    created_at: "2026-01-01T00:00:00Z",
    status: "ACTIVE_HEALTHY" as const,
    database: { host: "h", version: "15", postgres_engine: "15", release_channel: "ga" },
  };
}

function entitlementResponse(opts: { readonly featureKey: string; readonly hasAccess: boolean }) {
  return {
    entitlements: [
      {
        feature: { key: opts.featureKey, type: "boolean" as const },
        hasAccess: opts.hasAccess,
        type: "boolean" as const,
        config: { enabled: !opts.hasAccess },
      },
    ],
  };
}

// V1GetABranchConfigOutput body — used by the resolver's UUID path. The
// returned `ref` becomes the `branch_id_or_ref` for the PATCH call, so it must
// be a value that schema-validates against the oneOf union — UUID-shaped.
const BRANCH_CONFIG = {
  ref: BRANCH_UUID,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "h",
  db_port: 5432,
};

const tempRoot = useLegacyTempWorkdir("supabase-branches-update-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly patchStatus?: number;
}

function buildApi(opts: SetupOpts) {
  const patchStatus = opts.patchStatus ?? 200;
  return mockLegacyPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "PATCH" && request.url.includes("/v1/branches/")) {
          return legacyJsonResponse(request, patchStatus, patchStatus === 200 ? UPDATED : {});
        }
        if (request.method === "GET" && request.url.includes("/v1/branches/")) {
          return legacyJsonResponse(request, 200, BRANCH_CONFIG);
        }
        return legacyJsonResponse(request, 200, null);
      }),
  });
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const api = buildApi(opts);
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    analytics,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api, analytics };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const api = buildApi(opts);
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    analytics,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, analytics, telemetry, cache };
}

const baseFlags: LegacyBranchesUpdateFlags = {
  branchId: Option.none(),
  projectRef: Option.none(),
  name: Option.none(),
  gitBranch: Option.none(),
  persistent: Option.none(),
  status: Option.none(),
  notifyUrl: Option.none(),
};

describe("legacy branches update integration", () => {
  it.live("updates a branch with --name and emits 'Updated preview branch:' to stderr", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesUpdate({
        ...baseFlags,
        branchId: Option.some(BRANCH_UUID),
        name: Option.some("renamed"),
      });
      expect(out.stderrText).toContain("Updated preview branch:");
      expect(out.stdoutText).toContain("renamed");
    }).pipe(Effect.provide(layer));
  });

  it.live("includes optional flags in body only when set", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesUpdate({
        ...baseFlags,
        branchId: Option.some(BRANCH_UUID),
        name: Option.some("rename-x"),
        gitBranch: Option.some("git-x"),
        persistent: Option.some(true),
        notifyUrl: Option.some("https://hook.example.com"),
      });
      const patch = api.requests.find((r) => r.method === "PATCH");
      expect(patch?.body).toMatchObject({
        branch_name: "rename-x",
        git_branch: "git-x",
        persistent: true,
        notify_url: "https://hook.example.com",
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends `persistent: false` when --persistent is explicitly false (demote)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesUpdate({
        ...baseFlags,
        branchId: Option.some(BRANCH_UUID),
        persistent: Option.some(false),
      });
      const patch = api.requests.find((r) => r.method === "PATCH");
      expect(patch?.body).toMatchObject({ persistent: false });
    }).pipe(Effect.provide(layer));
  });

  it.live("omits `persistent` from body when the flag is absent (default)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesUpdate({
        ...baseFlags,
        branchId: Option.some(BRANCH_UUID),
      });
      const patch = api.requests.find((r) => r.method === "PATCH");
      expect(patch?.body).toBeDefined();
      expect((patch?.body as Record<string, unknown>) ?? {}).not.toHaveProperty("persistent");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits success event for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyBranchesUpdate({
        ...baseFlags,
        branchId: Option.some(BRANCH_UUID),
        name: Option.some("renamed"),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ name: "renamed" });
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesUpdateUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ patchStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesUpdate({ ...baseFlags, branchId: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesUpdateUnexpectedStatusError");
        expect(json).toContain("unexpected update branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyBranchesUpdate({
        ...baseFlags,
        branchId: Option.some(BRANCH_UUID),
        name: Option.some("renamed"),
      });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on failure", () => {
    const { layer, telemetry, cache } = setupTracked({ patchStatus: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(
        legacyBranchesUpdate({ ...baseFlags, branchId: Option.some(BRANCH_UUID) }),
      );
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Upgrade-suggest path uses the direct service mock so we can exercise the
  // production-shape branchRef (20-letter project ref) end-to-end. This is the
  // Go-parity assertion: the helper must be called with the resolved branch's
  // project ref, not the parent project ref. Mirrors `update.go:26`.
  // -------------------------------------------------------------------------
  it.live(
    "fires cli_upgrade_suggested with the branch ref + branching_persistent on 4xx gated",
    () => {
      const captured: Array<{ method: string; input: unknown }> = [];
      const out = mockOutput({ format: "text" });
      const analytics = mockAnalytics();
      const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });

      const apiMock = mockLegacyPlatformApiService({
        v1: {
          // Real `HttpClientError` with `StatusCodeError` reason so the handler's
          // `HttpClientError.isHttpClientError(cause)` check + `cause.response.status`
          // read see a 402.
          updateABranchConfig: () => Effect.fail(legacyStatusCodeFailure(402)),
          getProject: () => Effect.succeed(projectResponse(BRANCH_REF) as never),
          getOrganizationEntitlements: () =>
            Effect.succeed(
              entitlementResponse({
                featureKey: "branching_persistent",
                hasAccess: false,
              }) as never,
            ),
        },
      });

      const layer = buildLegacyTestRuntime({
        out,
        // The service mock's layer has no upstream error channel; the test
        // runtime's typing allows either layer shape here.
        api: { layer: apiMock.layer as never },
        cliConfig,
        analytics,
      });

      void captured;

      return Effect.gen(function* () {
        yield* Effect.exit(
          legacyBranchesUpdate({
            ...baseFlags,
            branchId: Option.some(BRANCH_REF),
            persistent: Option.some(true),
          }),
        );
        // The branch ref the resolver returned is what `legacySuggestUpgrade`
        // should query getProject with — Go parity.
        const projectCall = apiMock.requests.find((r) => r.method === "getProject");
        expect(projectCall?.input).toMatchObject({ ref: BRANCH_REF });
        expect(analytics.captured).toEqual([
          {
            event: "cli_upgrade_suggested",
            properties: { feature_key: "branching_persistent", org_slug: ORG_SLUG },
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );
});
