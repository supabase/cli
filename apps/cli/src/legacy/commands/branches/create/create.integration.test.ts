import type { V1CreateABranchOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockAnalytics, mockOutput } from "../../../../../tests/helpers/mocks.ts";
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
import type { LegacyBranchesCreateFlags } from "./create.command.ts";
import { legacyBranchesCreate } from "./create.handler.ts";

type CreatedBranch = typeof V1CreateABranchOutput.Type;

const CREATED: CreatedBranch = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "feat-x",
  project_ref: "aaaaaaaaaaaaaaaaaaaa",
  parent_project_ref: "bbbbbbbbbbbbbbbbbbbb",
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
};

const ORG_SLUG = "test-org";

function projectResponse() {
  return {
    id: LEGACY_VALID_REF,
    ref: LEGACY_VALID_REF,
    organization_id: "org",
    organization_slug: ORG_SLUG,
    name: "Test",
    region: "us-east-1",
    created_at: "2026-01-01T00:00:00Z",
    status: "ACTIVE_HEALTHY",
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

const tempRoot = useLegacyTempWorkdir("supabase-branches-create-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: CreatedBranch;
  readonly status?: number;
  readonly network?: "fail";
  readonly gated?: boolean;
  readonly featureKey?: string;
}

function buildApiLayer(opts: SetupOpts) {
  const status = opts.status ?? 201;
  const body = opts.response ?? CREATED;
  const featureKey = opts.featureKey ?? "branching_limit";
  return mockLegacyPlatformApi({
    network: opts.network,
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "POST" && request.url.includes("/branches")) {
          return legacyJsonResponse(request, status, body);
        }
        if (request.method === "GET" && request.url.endsWith(`/v1/projects/${LEGACY_VALID_REF}`)) {
          return legacyJsonResponse(request, 200, projectResponse());
        }
        if (request.method === "GET" && request.url.includes("/entitlements")) {
          return legacyJsonResponse(
            request,
            200,
            entitlementResponse({ featureKey, hasAccess: !(opts.gated ?? false) }),
          );
        }
        return legacyJsonResponse(request, 200, null);
      }),
  });
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const api = buildApiLayer(opts);
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
  const api = buildApiLayer(opts);
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
  return { layer, out, api, telemetry, cache, analytics };
}

const baseFlags: LegacyBranchesCreateFlags = {
  name: Option.none(),
  projectRef: Option.none(),
  region: Option.none(),
  size: Option.none(),
  persistent: Option.none(),
  withData: Option.none(),
  notifyUrl: Option.none(),
};

describe("legacy branches create integration", () => {
  it.live("creates a branch with explicit name and prints text-mode header + table", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      expect(out.stdoutText).toContain("Created preview branch:");
      expect(out.stdoutText).toContain("feat-x");
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/branches`);
      expect(api.requests[0]?.body).toMatchObject({
        branch_name: "feat-x",
        is_default: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("includes optional flags in the request body only when set", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({
        ...baseFlags,
        name: Option.some("with-region"),
        region: Option.some("us-east-1"),
        persistent: Option.some(true),
        withData: Option.some(true),
        notifyUrl: Option.some("https://hook.example.com"),
      });
      expect(api.requests[0]?.body).toMatchObject({
        branch_name: "with-region",
        is_default: false,
        region: "us-east-1",
        persistent: true,
        with_data: true,
        notify_url: "https://hook.example.com",
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ name: "feat-x" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact indented JSON for --output json", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      expect(out.stdoutText).toContain("Created preview branch:");
      expect(out.stdoutText).toContain('"name": "feat-x"');
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesCreateNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesCreateNetworkError");
        expect(json).toContain("failed to create preview branch");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesCreateUnexpectedStatusError on non-201", () => {
    const { layer } = setup({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesCreateUnexpectedStatusError");
        expect(json).toContain("unexpected create branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fires cli_upgrade_suggested with feature_key=branching_limit on 402 gated", () => {
    const { layer, analytics } = setup({ status: 402, gated: true });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }));
      expect(analytics.captured).toEqual([
        {
          event: "cli_upgrade_suggested",
          properties: { feature_key: "branching_limit", org_slug: ORG_SLUG },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("does NOT fire upgrade suggested on 500 (Go skips 5xx)", () => {
    const { layer, analytics } = setup({ status: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }));
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache and telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry on the upgrade-suggest failure path", () => {
    const { layer, telemetry, cache } = setupTracked({ status: 402, gated: true });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
