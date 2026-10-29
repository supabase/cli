import type { V1ListAllProjectsOutput } from "@supabase/api/effect";
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
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import type { BranchesDisableFlags } from "./disable.command.ts";
import { branchesDisable } from "./disable.handler.ts";
import { YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";

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

const tempRoot = useTempWorkdir("supabase-branches-disable-int-");

const buildRuntime = (opts: Parameters<typeof buildTestRuntime>[0]) =>
  Layer.mergeAll(
    buildTestRuntime(opts),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );

interface SetupOpts {
  readonly status?: number;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: null },
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildRuntime({ out, api, cliSettings });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: null },
  });
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

const baseFlags: BranchesDisableFlags = {
  remote: Option.none(),
  projectRef: Option.none(),
};

describe("branches disable integration", () => {
  it.effect("disables preview branching and emits header to stdout", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* branchesDisable(baseFlags);
      expect(out.stdoutText).toContain(`Disabled preview branching for project: ${VALID_REF}`);
      expect(api.requests.find((r) => r.method === "DELETE")?.url).toContain(
        `/v1/projects/${VALID_REF}/branches`,
      );
      assertPermissionDrift({
        command: "branches disable",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "lists projects for the picker, disables branching, then fills the linked-project cache",
    () => {
      const out = mockOutput({ format: "text", promptSelectResponses: [VALID_REF] });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          if (request.method === "DELETE") {
            return Effect.succeed(jsonResponse(request, 200, null));
          }
          return Effect.succeed(
            jsonResponse(
              request,
              200,
              request.url === "https://api.supabase.com/v1/projects" ? [PROJECT] : PROJECT,
            ),
          );
        },
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
        yield* branchesDisable(baseFlags);
        expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          "GET https://api.supabase.com/v1/projects",
          `DELETE https://api.supabase.com/v1/projects/${VALID_REF}/branches`,
          `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
        ]);
        expect(out.stdoutText).toContain(`Disabled preview branching for project: ${VALID_REF}`);
        expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
          ref: VALID_REF,
        });
        assertPermissionDrift({
          command: "branches disable",
          requests: api.requests,
          exact: true,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("fails with BranchesDisableUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(branchesDisable(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesDisableUnexpectedStatusError");
        expect(causeText).toContain("unexpected disable branching status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* branchesDisable(baseFlags);
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

describeHostedConsent("branches disable", {
  api: { response: { status: 200, body: null } },
  invoke: () => ({ run: branchesDisable(baseFlags) }),
});
