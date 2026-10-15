import { type V1ListAllProjectsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, FileSystem, Schema } from "effect";

import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
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
  unverifiedTargetBanner,
} from "../../../../tests/helpers/command-mocks.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import type { BranchesPauseFlags } from "./pause.command.ts";
import { branchesPause } from "./pause.handler.ts";
import { YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";

// Pause/restore endpoints accept a plain project ref, unlike getABranchConfig's oneOf.
const BRANCH_REF = "cccccccccccccccccccc";
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";

const BRANCH_CONFIG = {
  ref: BRANCH_REF,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "db.cccccccccccccccccccc.supabase.co",
  db_port: 5432,
};

const BRANCH_NAMED_LOOKUP = {
  id: BRANCH_UUID,
  name: "feat-x",
  project_ref: BRANCH_REF,
  parent_project_ref: VALID_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
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

const tempRoot = useTempWorkdir("supabase-branches-pause-int-");

const buildRuntime = (opts: Parameters<typeof buildTestRuntime>[0]) =>
  Layer.mergeAll(
    buildTestRuntime(opts),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );

const confirmed = `Confirmed by --yes: Pause preview branch ${BRANCH_REF} on project ${VALID_REF} · identity unverified\n`;
const sequence = (requests: ReadonlyArray<{ method: string; url: string }>) =>
  requests.map(({ method, url }) => `${method} ${url}`);

function pickerApi() {
  return mockCommandPlatformApi({
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
            { ...BRANCH_NAMED_LOOKUP, name: "other", project_ref: OTHER_BRANCH_REF },
            BRANCH_NAMED_LOOKUP,
          ]);
        }
        if (request.method === "POST" && request.url === `${API}/v1/projects/${BRANCH_REF}/pause`) {
          return jsonResponse(request, 200, null);
        }
        return jsonResponse(request, 404, { message: "unexpected request" });
      }),
  });
}

interface SetupOpts {
  readonly pauseStatus?: number;
}

function apiOptions(opts: SetupOpts): MockCommandPlatformApiOpts {
  const pauseStatus = opts.pauseStatus ?? 200;
  return {
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "POST" && request.url.endsWith("/pause")) {
          return jsonResponse(request, pauseStatus, null);
        }
        if (request.method === "GET" && request.url.includes("/v1/branches/")) {
          return jsonResponse(request, 200, BRANCH_CONFIG);
        }
        if (
          request.method === "GET" &&
          request.url.includes(`/v1/projects/${VALID_REF}/branches/`)
        ) {
          return jsonResponse(request, 200, BRANCH_NAMED_LOOKUP);
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

const baseFlags: BranchesPauseFlags = {
  name: Option.none(),
  projectRef: Option.none(),
};

describe("branches pause integration", () => {
  it.effect("pauses a branch when given a project-ref pattern (skips lookup)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesPause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      const post = api.requests.find((r) => r.method === "POST");
      expect(post?.url).toContain(`/v1/projects/${BRANCH_REF}/pause`);
      expect(api.requests.find((r) => r.method === "GET")).toBeUndefined();
      assertPermissionDrift({ command: "branches pause", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves a UUID via V1GetABranchConfig and then pauses", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesPause({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(api.requests.some((r) => r.method === "GET" && r.url.includes("/v1/branches/"))).toBe(
        true,
      );
      expect(api.requests.find((r) => r.method === "POST")?.url).toContain(
        `/v1/projects/${BRANCH_REF}/pause`,
      );
      expect(sequence(api.requests)).toEqual([
        `GET ${API}/v1/branches/${BRANCH_UUID}`,
        `POST ${API}/v1/projects/${BRANCH_REF}/pause`,
      ]);
      assertPermissionDrift({ command: "branches pause", requests: api.requests });
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves a plain name via the project's branches endpoint", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesPause({ ...baseFlags, name: Option.some("feat-x") });
      expect(
        api.requests.some((r) => r.url.includes(`/v1/projects/${VALID_REF}/branches/feat-x`)),
      ).toBe(true);
      expect(api.requests.find((r) => r.method === "POST")?.url).toContain(
        `/v1/projects/${BRANCH_REF}/pause`,
      );
      expect(sequence(api.requests)).toEqual([
        `GET ${API}/v1/projects/${VALID_REF}/branches/feat-x`,
        `POST ${API}/v1/projects/${BRANCH_REF}/pause`,
      ]);
      assertPermissionDrift({ command: "branches pause", requests: api.requests });
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not emit anything on stdout/stderr on success", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* branchesPause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe(unverifiedTargetBanner() + confirmed);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesPauseUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ pauseStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesPause({ ...baseFlags, name: Option.some(BRANCH_REF) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesPauseUnexpectedStatusError");
        expect(causeText).toContain("unexpected pause branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes linked-project cache and telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* branchesPause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "pauses the branch chosen from the pickers and fills the real linked-project cache",
    () => {
      const out = mockOutput({ format: "text", promptSelectResponses: [VALID_REF, BRANCH_REF] });
      const api = pickerApi();
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

        yield* branchesPause(baseFlags);

        expect(sequence(api.requests)).toEqual([
          `GET ${API}/v1/projects`,
          `GET ${API}/v1/projects/${VALID_REF}/branches`,
          `POST ${API}/v1/projects/${BRANCH_REF}/pause`,
          `GET ${API}/v1/projects/${VALID_REF}`,
        ]);
        expect(out.stderrText).toContain(`Selected branch ID: ${BRANCH_REF}`);
        expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
          ref: VALID_REF,
        });
        assertPermissionDrift({ command: "branches pause", requests: api.requests, exact: true });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("prompts with the branch listing when the branch argument is an empty string", () => {
    const out = mockOutput({ format: "text", promptSelectResponses: [BRANCH_REF] });
    const api = pickerApi();
    const layer = buildRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      tty: mockTty({ stdinIsTty: true }),
    });
    return Effect.gen(function* () {
      yield* branchesPause({ ...baseFlags, name: Option.some("") });

      expect(sequence(api.requests)).toEqual([
        `GET ${API}/v1/projects/${VALID_REF}/branches`,
        `POST ${API}/v1/projects/${BRANCH_REF}/pause`,
      ]);
      assertPermissionDrift({ command: "branches pause", requests: api.requests });
    }).pipe(Effect.provide(layer));
  });
});

describeHostedConsent("branches pause", {
  api: apiOptions({}),
  invoke: () => ({ run: branchesPause({ ...baseFlags, name: Option.some(BRANCH_REF) }) }),
});
