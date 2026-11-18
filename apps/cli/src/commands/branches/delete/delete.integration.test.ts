import { type V1ListAllProjectsOutput } from "@supabase/api/effect";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";

import {
  mockAnalytics,
  mockOutput,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandCredentialsLayer,
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
import {
  realLinkedProjectCache,
  realPlatformApiFactory,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { commandPlatformApiFactoryFromApiLayer } from "../../../auth/command-platform-api-factory.layer.ts";
import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { readContract } from "../../../command-internal/command-contract/command-contract.annotation.ts";
import { managementApiGuardLayer } from "../../../command-internal/command-contract/management-api-guard.ts";
import { readPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { branchPrompt } from "../branches.prompt.ts";
import { type BranchesDeleteFlags, branchesDeleteCommand } from "./delete.command.ts";
import { branchesDelete } from "./delete.handler.ts";
import { YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";

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

/** Serves the project picker, the branch listing, the delete of `BRANCH_REF` and the cache fill. */
const pickerApiOptions: MockCommandPlatformApiOpts = {
  handler: (request) =>
    Effect.sync(() => {
      if (request.method === "GET" && request.url === `${API}/v1/projects`) {
        return jsonResponse(request, 200, [PROJECT]);
      }
      if (request.method === "GET" && request.url === `${API}/v1/projects/${VALID_REF}`) {
        return jsonResponse(request, 200, PROJECT);
      }
      if (request.method === "GET" && request.url === `${API}/v1/projects/${VALID_REF}/branches`) {
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
};

const baseFlags: BranchesDeleteFlags = {
  name: Option.none(),
  remote: Option.none(),
  projectRef: Option.none(),
};

describe("branches delete integration", () => {
  it.effect("deletes a branch and emits 'Deleted preview branch: <ref>' to stderr", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* branchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) });
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
      yield* branchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      const del = api.requests.find((r) => r.method === "DELETE");
      expect(del?.url).not.toContain("force=");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesDeleteUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ deleteStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) }),
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
      yield* branchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes linked-project cache + telemetry state on failure", () => {
    const { layer, telemetry, cache } = setupTracked({ deleteStatus: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(branchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
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

        yield* branchesDelete({ ...baseFlags, name: Option.some("my-feature") });
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
      const api = mockCommandPlatformApi(pickerApiOptions);
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

        yield* branchesDelete(baseFlags);

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
  invoke: () => ({ run: branchesDelete({ ...baseFlags, name: Option.some(BRANCH_UUID) }) }),
});

const contract = Option.getOrThrow(readContract(branchesDeleteCommand));
const permissions = readPermissions(branchesDeleteCommand);
const OTHER_BRANCH_UUID = "22222222-2222-4222-8222-222222222222";

/**
 * The real Management API client, built by `makeCommandPlatformApi` over the recording client,
 * under the guard `withContract` provides for `flags`. The cache shares that client, as the
 * runtime layer arranges in production.
 */
function guardedSetup(opts: {
  readonly flags: BranchesDeleteFlags;
  readonly api: MockCommandPlatformApiOpts;
  readonly out?: ReturnType<typeof mockOutput>;
  readonly tty?: Parameters<typeof buildTestRuntime>[0]["tty"];
  readonly projectId?: Option.Option<string>;
  readonly realCache?: boolean;
}) {
  const out = opts.out ?? mockOutput({ format: "text" });
  const api = mockCommandPlatformApi(opts.api);
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    ...(opts.projectId === undefined ? {} : { projectId: opts.projectId }),
  });
  const analytics = mockAnalytics();
  const identityStitch = identityStitchLayer.pipe(
    Layer.provide(analytics.layer),
    Layer.provide(mockTelemetryRuntime()),
    Layer.provide(BunServices.layer),
  );
  const guard = managementApiGuardLayer(contract, permissions, opts.flags).pipe(
    Layer.provide(out.layer),
  );
  const platformApi = Layer.effect(
    CommandPlatformApi,
    CommandPlatformApiFactory.pipe(Effect.flatMap((factory) => factory.make)),
  ).pipe(
    Layer.provide(realPlatformApiFactory),
    Layer.provide(
      Layer.mergeAll(
        api.httpClientLayer,
        cliSettings,
        mockCommandCredentialsLayer,
        identityStitch,
        guard,
      ),
    ),
    Layer.orDie,
  );
  const layer = buildRuntime({
    out: { layer: guard },
    api: { layer: platformApi, httpClientLayer: api.httpClientLayer },
    cliSettings,
    ...(opts.tty === undefined ? {} : { tty: opts.tty }),
    ...(opts.realCache === true
      ? {
          linkedProjectCache: realLinkedProjectCache({
            httpClient: api.httpClientLayer,
            cliSettings,
            platformApiFactory: commandPlatformApiFactoryFromApiLayer.pipe(
              Layer.provide(platformApi),
            ),
          }),
        }
      : {}),
  });
  return { layer, out, api };
}

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("branches delete under its contract guard", () => {
  it.effect("deletes the branch picked at the prompt, a target only the answer supplies", () => {
    const { layer, api, out } = guardedSetup({
      flags: baseFlags,
      api: pickerApiOptions,
      out: mockOutput({ format: "text", promptSelectResponses: [VALID_REF, BRANCH_REF] }),
      tty: mockTty({ stdinIsTty: true }),
      projectId: Option.none(),
      realCache: true,
    });
    return Effect.gen(function* () {
      yield* branchesDelete(baseFlags);

      expect(sequence(api.requests)).toEqual([
        `GET ${API}/v1/projects`,
        `GET ${API}/v1/projects/${VALID_REF}/branches`,
        `DELETE ${API}/v1/branches/${BRANCH_REF}`,
        `GET ${API}/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stderrText).toContain(`Deleted preview branch: ${BRANCH_REF}`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a delete aimed at a branch no input, answer or lookup supplied", () => {
    const flags = { ...baseFlags, name: Option.some(BRANCH_UUID) };
    const { layer, api } = guardedSetup({ flags, api: apiOptions({}) });
    return Effect.gen(function* () {
      const platformApi = yield* CommandPlatformApi;

      const exit = yield* Effect.exit(
        platformApi.v1.deleteABranch({ branch_id_or_ref: OTHER_BRANCH_UUID }),
      );

      expect(failureOf(exit)).toMatchObject({
        _tag: "ContractViolation",
        message: expect.stringContaining(`targets branch_id_or_ref=${OTHER_BRANCH_UUID}`),
      });
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an operation the command doesn't declare before sending it", () => {
    const { layer, api } = guardedSetup({ flags: baseFlags, api: apiOptions({}) });
    return Effect.gen(function* () {
      const platformApi = yield* CommandPlatformApi;

      const exit = yield* Effect.exit(platformApi.v1.listAllOrganizations());

      expect(failureOf(exit)).toMatchObject({
        _tag: "ContractViolation",
        message: "v1-list-all-organizations is not declared by the command",
      });
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a second delete past the contract's max of one", () => {
    const flags = { ...baseFlags, name: Option.some(BRANCH_UUID) };
    const { layer, api } = guardedSetup({ flags, api: apiOptions({}) });
    return Effect.gen(function* () {
      yield* branchesDelete(flags);
      const platformApi = yield* CommandPlatformApi;

      const exit = yield* Effect.exit(
        platformApi.v1.deleteABranch({ branch_id_or_ref: BRANCH_UUID }),
      );

      expect(failureOf(exit)).toMatchObject({
        _tag: "ContractViolation",
        message: "v1-delete-a-branch would run 2 times; the contract allows 1",
      });
      expect(sequence(api.requests)).toEqual([
        `GET ${API}/v1/branches/${BRANCH_UUID}`,
        `DELETE ${API}/v1/branches/${BRANCH_UUID}`,
      ]);
    }).pipe(Effect.provide(layer));
  });
});
