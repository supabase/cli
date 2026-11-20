import { type V1ListAllProjectsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";

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
import {
  assertBlockDrift,
  assertPermissionDrift,
} from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import { branchPrompt } from "../branches.prompt.ts";
import type { BranchesDeleteFlags } from "./delete.command.ts";
import { runBranchesDelete } from "./delete.test-helper.ts";
import { YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { Output } from "../../../shared/output/output.service.ts";

// `branch_id_or_ref` is a oneOf [project-ref, uuid]; a 20-lowercase ref would match both shapes
// and get rejected, so tests use a v4 UUID to pick exactly one.
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";

// Used by the resolver's UUID path; the returned `ref` becomes `branch_id_or_ref` for the DELETE
// call, so it must be UUID-shaped.
const BRANCH_CONFIG = {
  ref: BRANCH_UUID,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "h",
  db_port: 5432,
};

const BRANCH_REF = "cccccccccccccccccccc";
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

const branchListing = (projectRef: string, name: string) => ({
  id: "33333333-3333-4333-8333-333333333333",
  name,
  project_ref: projectRef,
  parent_project_ref: VALID_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  with_data: false,
});

const tempRoot = useTempWorkdir("supabase-branches-delete-int-");

const buildRuntime = (opts: Parameters<typeof buildTestRuntime>[0]) =>
  Layer.mergeAll(
    buildTestRuntime(opts),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );
const sequence = (requests: ReadonlyArray<{ method: string; url: string }>) =>
  requests.map(({ method, url }) => `${method} ${url}`);

interface SetupOpts {
  readonly deleteStatus?: number;
}

function apiOptions(opts: SetupOpts): MockCommandPlatformApiOpts {
  const deleteStatus = opts.deleteStatus ?? 200;
  return {
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "DELETE" && request.url.includes("/v1/branches/")) {
          return jsonResponse(request, deleteStatus, deleteStatus === 200 ? { message: "ok" } : {});
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
  const out = mockOutput({ format: "text" });
  const api = buildApi(opts);
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildRuntime({ out, api, cliSettings });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: "text" });
  const api = buildApi(opts);
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const layer = buildRuntime({
    out,
    api,
    cliSettings,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, telemetry, cache };
}

const baseFlags: BranchesDeleteFlags = {
  name: Option.none(),
  remote: Option.none(),
  projectRef: Option.none(),
};

describe("branches delete integration", () => {
  it.effect("deletes a branch and emits 'Deleted preview branch: <ref>' to stderr", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* runBranchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(out.stderrText).toContain(`Deleted preview branch: ${BRANCH_UUID}`);
      expect(api.requests.find((r) => r.method === "DELETE")?.url).toContain(
        `/v1/branches/${BRANCH_UUID}`,
      );
      expect(sequence(api.requests)).toEqual([
        `GET ${API}/v1/branches/${BRANCH_UUID}`,
        `DELETE ${API}/v1/branches/${BRANCH_UUID}`,
      ]);
      assertPermissionDrift({ command: "branches delete", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("omits the force query param", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* runBranchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      const del = api.requests.find((r) => r.method === "DELETE");
      expect(del?.url).not.toContain("force=");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesDeleteUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ deleteStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runBranchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesDeleteUnexpectedStatusError");
        expect(causeText).toContain("unexpected delete branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* runBranchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches the parent and flushes once before reporting a typed DELETE failure", () => {
    const out = mockOutput({ format: "json" });
    const analytics = mockAnalytics();
    const telemetry = mockTelemetryStateTracked();
    const cache = mockLinkedProjectCacheTracked();
    const api = buildApi({ deleteStatus: 500 });
    const layer = buildRuntime({
      out,
      analytics,
      api,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    });
    const beforeReports: Array<readonly [number, number]> = [];
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runBranchesDelete({
          ...baseFlags,
          name: Option.some(BRANCH_UUID),
          projectRef: Option.some(VALID_REF),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(beforeReports).toEqual([[1, 1]]);
      expect(cache.cacheCount).toBe(1);
      expect(cache.cachedRef).toBe(VALID_REF);
      expect(telemetry.flushCount).toBe(1);
      expect(out.failures).toEqual([
        {
          code: "BranchesDeleteUnexpectedStatusError",
          message: "unexpected delete branch status 500: {}",
        },
      ]);
      expect(analytics.captured).toEqual([
        expect.objectContaining({
          event: "cli_command_executed",
          properties: expect.objectContaining({
            exit_code: 1,
            error_fingerprint: "tag:BranchesDeleteUnexpectedStatusError:api_status",
          }),
        }),
      ]);
    }).pipe(
      Effect.provideServiceEffect(
        Output,
        Output.use((output) =>
          Effect.succeed({
            ...output,
            fail: (error) =>
              Effect.sync(() => {
                beforeReports.push([cache.cacheCount, telemetry.flushCount]);
              }).pipe(Effect.andThen(output.fail(error))),
          }),
        ),
      ),
      Effect.provide(layer),
    );
  });

  it.effect("does not cache or flush when parent resolution fails", () => {
    const { layer, api, out, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runBranchesDelete({
          ...baseFlags,
          name: Option.some(BRANCH_UUID),
          remote: Option.some({ _tag: "Branch", name: "feat-x" }),
        }),
      );
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        _tag: "TargetNeedsProjectError",
      });
      expect(api.requests).toEqual([]);
      expect(cache.cacheCount).toBe(0);
      expect(telemetry.flushCount).toBe(0);
      expect(out.failures).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches the parent and flushes once when an in-flight DELETE is interrupted", () =>
    Effect.gen(function* () {
      const deleteStarted = yield* Deferred.make<void>();
      const out = mockOutput({ format: "json" });
      const telemetry = mockTelemetryStateTracked();
      const cache = mockLinkedProjectCacheTracked();
      const api = mockCommandPlatformApi({
        handler: (request) =>
          request.method === "DELETE"
            ? Deferred.succeed(deleteStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(jsonResponse(request, 200, BRANCH_CONFIG)),
      });
      const layer = buildRuntime({
        out,
        api,
        telemetry: telemetry.layer,
        linkedProjectCache: cache.layer,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      });
      const fiber = yield* runBranchesDelete({
        ...baseFlags,
        name: Option.some(BRANCH_UUID),
        projectRef: Option.some(VALID_REF),
      }).pipe(Effect.provide(layer), Effect.forkChild);
      yield* Deferred.await(deleteStarted);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(cache.cacheCount).toBe(1);
      expect(cache.cachedRef).toBe(VALID_REF);
      expect(telemetry.flushCount).toBe(1);
      expect(out.stdoutText).toBe("");
      expect(out.failures).toEqual([]);
    }),
  );

  it.effect("caches the parent and flushes once after a partial terminal write fails", () => {
    const out = mockOutput({ format: "stream-json" });
    const api = buildApi({});
    const cache = mockLinkedProjectCacheTracked();
    const telemetry = mockTelemetryStateTracked();
    const defect = new Error("terminal write failed");
    const atWrite: Array<readonly [number, number]> = [];
    const layer = buildRuntime({
      out,
      api,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runBranchesDelete({
          ...baseFlags,
          name: Option.some(BRANCH_UUID),
          projectRef: Option.some(VALID_REF),
        }),
      );
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect);
      expect(atWrite).toEqual([[0, 0]]);
      expect(cache.cacheCount).toBe(1);
      expect(cache.cachedRef).toBe(VALID_REF);
      expect(telemetry.flushCount).toBe(1);
      expect(out.stdoutText).toBe('{"type":"result",');
      expect(out.failures).toEqual([]);
    }).pipe(
      Effect.provideServiceEffect(
        Output,
        Output.use((output) =>
          Effect.succeed({
            ...output,
            result: () =>
              Effect.sync(() => {
                atWrite.push([cache.cacheCount, telemetry.flushCount]);
              }).pipe(
                Effect.andThen(output.raw('{"type":"result",', "stdout")),
                Effect.andThen(Effect.die(defect)),
              ),
          }),
        ),
      ),
      Effect.provide(layer),
    );
  });

  it.effect(
    "resolves a branch NAME against the linked PARENT (not the branch's own ref) after `supabase link <branch>` (CLI-2167 follow-up)",
    () => {
      const PARENT_REF = "parentprojectrefxxxx";
      const BRANCH_OWN_REF = "branchownrefyyyyyyyy";
      const RESOLVED_BRANCH_UUID = "22222222-2222-4222-8222-222222222222";
      // Its own `project_ref` becomes `branch_id_or_ref` for the subsequent DELETE call, so it
      // must be UUID-shaped (see the oneOf note on `BRANCH_UUID` above).
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
      const api = mockCommandPlatformApi({
        handler: (request) =>
          Effect.sync(() => {
            if (request.method === "GET" && request.url.includes("/branches/my-feature")) {
              return jsonResponse(request, 200, NAME_LOOKUP_BRANCH);
            }
            if (request.method === "DELETE" && request.url.includes("/v1/branches/")) {
              return jsonResponse(request, 200, { message: "ok" });
            }
            if (
              request.method === "GET" &&
              request.url === `${API}/v1/projects/${PARENT_REF}/branches`
            ) {
              return jsonResponse(request, 200, [branchListing(BRANCH_OWN_REF, "linked-branch")]);
            }
            return jsonResponse(request, 200, null);
          }),
      });
      const cliSettings = mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
      const layer = buildRuntime({ out, api, cliSettings });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Simulates the state left by `supabase link <branch>`: project-ref holds the branch's own
        // ref, but linked-project.json still holds the real parent — `branches delete` must
        // resolve the parent for the name lookup, not the branch ref sitting in project-ref.
        const tempDir = path.join(tempRoot.current, "supabase", ".temp");
        yield* fs.makeDirectory(tempDir, { recursive: true });
        yield* fs.writeFileString(path.join(tempDir, "project-ref"), BRANCH_OWN_REF);
        yield* fs.writeFileString(
          path.join(tempDir, "linked-project.json"),
          `{"ref":"${PARENT_REF}","name":"Parent Project","organization_id":"org_1","organization_slug":"acme"}`,
        );

        yield* runBranchesDelete({ ...baseFlags, name: Option.some("my-feature") });
        const lookup = api.requests.find(
          (r) => r.method === "GET" && r.url.includes("/branches/my-feature"),
        );
        expect(lookup?.url).toContain(`/v1/projects/${PARENT_REF}/branches/my-feature`);
        const del = api.requests.find((r) => r.method === "DELETE");
        expect(del?.url).toContain(`/v1/branches/${RESOLVED_BRANCH_UUID}`);
        expect(sequence(api.requests)).toEqual([
          `GET ${API}/v1/projects/${PARENT_REF}/branches`,
          `GET ${API}/v1/projects/${PARENT_REF}/branches/my-feature`,
          `DELETE ${API}/v1/branches/${RESOLVED_BRANCH_UUID}`,
        ]);
        assertPermissionDrift({ command: "branches delete", requests: api.requests });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "deletes the branch chosen from the pickers and fills the real linked-project cache",
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
                branchListing(OTHER_BRANCH_REF, "other"),
                branchListing(BRANCH_REF, "feat-x"),
              ]);
            }
            if (request.method === "DELETE" && request.url === `${API}/v1/branches/${BRANCH_REF}`) {
              return jsonResponse(request, 200, { message: "ok" });
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

        yield* runBranchesDelete(baseFlags);

        expect(sequence(api.requests)).toEqual([
          `GET ${API}/v1/projects`,
          `GET ${API}/v1/projects/${VALID_REF}/branches`,
          `DELETE ${API}/v1/branches/${BRANCH_REF}`,
          `GET ${API}/v1/projects/${VALID_REF}`,
        ]);
        expect(out.stderrText).toContain(`Deleted preview branch: ${BRANCH_REF}`);
        expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
          ref: VALID_REF,
        });
        assertPermissionDrift({ command: "branches delete", requests: api.requests, exact: true });
        assertBlockDrift(branchPrompt, { requests: api.requests.slice(1, 2) });
      }).pipe(Effect.provide(layer));
    },
  );
});

describeHostedConsent("branches delete", {
  api: apiOptions({}),
  invoke: () => ({ run: runBranchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) }) }),
});
