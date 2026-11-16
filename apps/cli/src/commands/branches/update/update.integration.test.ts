import {
  type V1UpdateABranchConfigOutput,
  type V1ListAllProjectsOutput,
} from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, FileSystem, Schema } from "effect";
import { mockAnalytics, mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";

import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  type MockCommandPlatformApiOpts,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import type { BranchesUpdateFlags } from "./update.command.ts";
import { branchesUpdate } from "./update.handler.ts";
import { YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { classifyCliCauseActionability } from "../../../shared/telemetry/error-actionability.ts";

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

const OTHER_BRANCH_REF = "dddddddddddddddddddd";
const API = "https://api.supabase.com";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const PROJECT: (typeof V1ListAllProjectsOutput.Type)[number] = {
  id: VALID_REF,
  ref: VALID_REF,
  organization_id: "org-123",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  created_at: "2026-05-27T01:02:03Z",
  status: "ACTIVE_HEALTHY",
  database: {
    host: "db.alpha.supabase.co",
    version: "15.1",
    postgres_engine: "15",
    release_channel: "ga",
  },
};

const tempRoot = useTempWorkdir("supabase-branches-update-int-");

const buildRuntime = (opts: Parameters<typeof buildTestRuntime>[0]) =>
  Layer.mergeAll(
    buildTestRuntime(opts),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );
const sequence = (requests: ReadonlyArray<{ method: string; url: string }>) =>
  requests.map(({ method, url }) => `${method} ${url}`);

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly patchStatus?: number;
}

function apiOptions(opts: SetupOpts): MockCommandPlatformApiOpts {
  const patchStatus = opts.patchStatus ?? 200;
  return {
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
  };
}

function buildApi(opts: SetupOpts) {
  return mockCommandPlatformApi(apiOptions(opts));
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const api = buildApi(opts);
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildRuntime({
    out,
    api,
    cliSettings,
    analytics,
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
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
  const layer = buildRuntime({
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
  remote: Option.none(),
  projectRef: Option.none(),
  name: Option.none(),
  gitBranch: Option.none(),
  persistent: Option.none(),
  status: Option.none(),
  notifyUrl: Option.none(),
};

describe("branches update integration", () => {
  it.effect("updates a branch with --name and emits 'Updated preview branch:' to stderr", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* branchesUpdate({
        ...baseFlags,
        branchId: Option.some(BRANCH_UUID),
        name: Option.some("renamed"),
      });
      expect(out.stderrText).toContain("Updated preview branch:");
      expect(out.stdoutText).toContain("renamed");
      expect(sequence(api.requests)).toEqual([
        `GET ${API}/v1/branches/${BRANCH_UUID}`,
        `PATCH ${API}/v1/branches/${BRANCH_UUID}`,
      ]);
      assertPermissionDrift({
        command: "branches update",
        activeFlags: { name: true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("includes optional flags in body only when set", () => {
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
      assertPermissionDrift({
        command: "branches update",
        activeFlags: { name: true, "git-branch": true, persistent: true, "notify-url": true },
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends `persistent: false` when --persistent is explicitly false (demote)", () => {
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

  it.effect("omits `persistent` from body when the flag is absent (default)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesUpdate({
        ...baseFlags,
        branchId: Option.some(BRANCH_UUID),
      });
      const patch = api.requests.find((r) => r.method === "PATCH");
      expect(patch?.body).toBeDefined();
      expect(patch?.body).not.toHaveProperty("persistent");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits success event for --output-format=json", () => {
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

  it.effect("fails with BranchesUpdateUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ patchStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesUpdate({ ...baseFlags, branchId: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesUpdateUnexpectedStatusError");
        expect(causeText).toContain("unexpected update branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes linked-project cache + telemetry state on success", () => {
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

  it.effect("writes linked-project cache + telemetry state on failure", () => {
    const { layer, telemetry, cache } = setupTracked({ patchStatus: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(branchesUpdate({ ...baseFlags, branchId: Option.some(BRANCH_UUID) }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "fails a persistent-branch 402 envelope with its entitlement and no extra API calls",
    () => {
      const out = mockOutput({ format: "text" });
      const analytics = mockAnalytics();
      const upgradeUrl = "https://supabase.com/dashboard/org/env-org/billing";
      const api = mockCommandPlatformApi({
        handler: (request) =>
          Effect.sync(() =>
            jsonResponse(request, 402, {
              message: "Persistent branches are not available on your plan.",
              error: {
                code: "entitlement_required",
                feature: "branching_persistent",
                upgrade_url: upgradeUrl,
              },
            }),
          ),
      });
      const layer = buildRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        analytics,
      });

      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          branchesUpdate({
            ...baseFlags,
            branchId: Option.some(BRANCH_REF),
            persistent: Option.some(true),
          }),
        );
        expect(error).toMatchObject({
          entitlement: { feature: "branching_persistent", upgrade_url: upgradeUrl },
        });
        expect(sequence(api.requests)).toEqual([`PATCH ${API}/v1/branches/${BRANCH_REF}`]);
        assertPermissionDrift({
          command: "branches update",
          activeFlags: { persistent: true },
          requests: api.requests,
          exact: true,
        });
        expect(out.stderrText).not.toContain("Upgrade your plan:");
        expect(analytics.captured).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("makes one request and suggests no upgrade on a 4xx without the envelope", () => {
    const out = mockOutput({ format: "text" });
    const analytics = mockAnalytics();
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.sync(() => jsonResponse(request, 400, { message: "Invalid branch name" })),
    });
    const layer = buildRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      analytics,
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesUpdate({
          ...baseFlags,
          branchId: Option.some(BRANCH_REF),
          persistent: Option.some(true),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(classifyCliCauseActionability(exit.cause).error_category).not.toBe("plan_limit");
      }
      expect(sequence(api.requests)).toEqual([`PATCH ${API}/v1/branches/${BRANCH_REF}`]);
      expect(out.stderrText).not.toContain("Upgrade your plan:");
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "updates the branch chosen from the pickers and fills the real linked-project cache",
    () => {
      const out = mockOutput({ format: "text", promptSelectResponses: [VALID_REF, BRANCH_REF] });
      const api = mockCommandPlatformApi({
        handler: (request) =>
          Effect.sync(() => {
            if (request.method === "GET" && request.url === `${API}/v1/projects`) {
              return jsonResponse(request, 200, [PROJECT]);
            }
            if (request.method === "GET" && request.url === `${API}/v1/projects/${VALID_REF}`) {
              return jsonResponse(request, 200, PROJECT);
            }
            if (
              request.method === "GET" &&
              request.url === `${API}/v1/projects/${VALID_REF}/branches`
            ) {
              return jsonResponse(request, 200, [
                { ...UPDATED, name: "other", project_ref: OTHER_BRANCH_REF },
                { ...UPDATED, name: "feat-x" },
              ]);
            }
            if (request.method === "PATCH" && request.url === `${API}/v1/branches/${BRANCH_REF}`) {
              return jsonResponse(request, 200, UPDATED);
            }
            return jsonResponse(request, 404, { message: "unexpected request" });
          }),
      });
      const cliSettings = mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
      const layer = buildRuntime({
        out,
        api,
        cliSettings,
        tty: mockTty({ stdinIsTty: true }),
        linkedProjectCache: realLinkedProjectCache({
          httpClient: api.httpClientLayer,
          cliSettings,
        }),
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
        expect(yield* fs.exists(cachePath)).toBe(false);

        yield* branchesUpdate({ ...baseFlags, name: Option.some("renamed") });

        expect(sequence(api.requests)).toEqual([
          `GET ${API}/v1/projects`,
          `GET ${API}/v1/projects/${VALID_REF}/branches`,
          `PATCH ${API}/v1/branches/${BRANCH_REF}`,
          `GET ${API}/v1/projects/${VALID_REF}`,
        ]);
        expect(out.stderrText).toContain("Updated preview branch:");
        expect(out.stdoutText).toContain("renamed");
        expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
          ref: VALID_REF,
        });
        assertPermissionDrift({
          command: "branches update",
          activeFlags: { name: true },
          requests: api.requests,
          exact: true,
        });
      }).pipe(Effect.provide(layer));
    },
  );
});

describeHostedConsent("branches update", {
  api: apiOptions({}),
  invoke: () => ({
    run: branchesUpdate({
      ...baseFlags,
      branchId: Option.some(BRANCH_UUID),
      name: Option.some("renamed"),
    }),
  }),
});
