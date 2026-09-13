import { type V1UpdateABranchConfigOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockAnalytics, mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import type { BranchesUpdateFlags } from "./update.command.ts";
import { branchesUpdate } from "./update.handler.ts";

type UpdatedBranch = typeof V1UpdateABranchConfigOutput.Type;

// Tests use a UUID so branch_id_or_ref's oneOf union stays unambiguous; a lowercase ref
// could match either variant.
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

// Resolver's UUID-path response; its `ref` feeds the PATCH's branch_id_or_ref, so it must
// stay UUID-shaped to satisfy the oneOf union.
const BRANCH_CONFIG = {
  ref: BRANCH_UUID,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "h",
  db_port: 5432,
};

const tempRoot = useTempWorkdir("supabase-branches-update-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly patchStatus?: number;
}

function buildApi(opts: SetupOpts) {
  const patchStatus = opts.patchStatus ?? 200;
  return mockCommandPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "PATCH" && request.url.includes("/v1/branches/")) {
          return jsonResponse(request, patchStatus, patchStatus === 200 ? UPDATED : {});
        }
        if (request.method === "GET" && request.url.includes("/v1/branches/")) {
          return jsonResponse(request, 200, BRANCH_CONFIG);
        }
        return jsonResponse(request, 200, null);
      }),
  });
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const api = buildApi(opts);
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    analytics,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api, analytics };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const api = buildApi(opts);
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    analytics,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, analytics, telemetry, cache };
}

const baseFlags: BranchesUpdateFlags = {
  branchId: Option.none(),
  projectRef: Option.none(),
  name: Option.none(),
  gitBranch: Option.none(),
  persistent: Option.none(),
  status: Option.none(),
  notifyUrl: Option.none(),
};

describe("branches update integration", () => {
  it.live("updates a branch with --name and emits 'Updated preview branch:' to stderr", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* branchesUpdate({
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
      yield* branchesUpdate({
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
      yield* branchesUpdate({
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
      yield* branchesUpdate({
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
      yield* branchesUpdate({
        ...baseFlags,
        branchId: Option.some(BRANCH_UUID),
        name: Option.some("renamed"),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ name: "renamed" });
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with BranchesUpdateUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ patchStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesUpdate({ ...baseFlags, branchId: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("BranchesUpdateUnexpectedStatusError");
        expect(json).toContain("unexpected update branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* branchesUpdate({
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
      yield* Effect.exit(branchesUpdate({ ...baseFlags, branchId: Option.some(BRANCH_UUID) }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  // Exercises the production-shape branchRef end-to-end; the upgrade-suggest helper must
  // receive the resolved branch's project ref, not the parent ref.
  it.live(
    "fires cli_upgrade_suggested with the branch ref + branching_persistent on 4xx gated",
    () => {
      const out = mockOutput({ format: "text" });
      const analytics = mockAnalytics();
      const cliSettings = mockCommandSettings({ workdir: tempRoot.current });

      // suggestUpgrade bypasses the typed API client (so cli-e2e replay fixtures with
      // `__PROJECT_REF__` placeholders don't trip strict schema decode), so all three URLs
      // route through the same mockCommandPlatformApi handler the production HttpClient uses.
      const apiMock = mockCommandPlatformApi({
        handler: (request) =>
          Effect.sync(() => {
            if (request.method === "PATCH" && request.url.includes("/v1/branches/")) {
              return jsonResponse(request, 402, { message: "upgrade required" });
            }
            if (request.method === "GET" && request.url.endsWith(`/v1/projects/${BRANCH_REF}`)) {
              return jsonResponse(request, 200, projectResponse(BRANCH_REF));
            }
            if (
              request.method === "GET" &&
              request.url.endsWith(`/v1/organizations/${ORG_SLUG}/entitlements`)
            ) {
              return jsonResponse(
                request,
                200,
                entitlementResponse({
                  featureKey: "branching_persistent",
                  hasAccess: false,
                }),
              );
            }
            return jsonResponse(request, 200, null);
          }),
      });

      const layer = buildTestRuntime({
        out,
        api: apiMock,
        cliSettings,
        analytics,
      });

      return Effect.gen(function* () {
        yield* Effect.exit(
          branchesUpdate({
            ...baseFlags,
            branchId: Option.some(BRANCH_REF),
            persistent: Option.some(true),
          }),
        );
        const projectCall = apiMock.requests.find(
          (r) => r.method === "GET" && r.url.endsWith(`/v1/projects/${BRANCH_REF}`),
        );
        expect(projectCall).toBeDefined();
        const entitlementsCall = apiMock.requests.find((r) =>
          r.url.endsWith(`/v1/organizations/${ORG_SLUG}/entitlements`),
        );
        expect(entitlementsCall).toBeDefined();
        expect(analytics.captured).toEqual([
          {
            event: "cli_upgrade_suggested",
            properties: { feature_key: "branching_persistent", org_slug: ORG_SLUG },
          },
        ]);
        expect(out.stderrText).toContain("Upgrade your plan:");
      }).pipe(Effect.provide(layer));
    },
  );
});
