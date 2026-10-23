import { type V1ListAllProjectsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import type { BranchesUnpauseFlags } from "./unpause.command.ts";
import { branchesUnpause } from "./unpause.handler.ts";

// 20-lowercase ref (matches V1RestoreAProjectInput.ref plain pattern).
const BRANCH_REF = "cccccccccccccccccccc";

const OTHER_BRANCH_REF = "dddddddddddddddddddd";
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";
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
  id: "11111111-1111-4111-8111-111111111111",
  name,
  project_ref: projectRef,
  parent_project_ref: VALID_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
});

const tempRoot = useTempWorkdir("supabase-branches-unpause-int-");

const sequence = (requests: ReadonlyArray<{ method: string; url: string }>) =>
  requests.map(({ method, url }) => `${method} ${url}`);

interface SetupOpts {
  readonly restoreStatus?: number;
}

function setup(opts: SetupOpts = {}) {
  const restoreStatus = opts.restoreStatus ?? 200;
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "POST" && request.url.endsWith("/restore")) {
          return jsonResponse(request, restoreStatus, null);
        }
        return jsonResponse(request, 200, null);
      }),
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildTestRuntime({ out, api, cliSettings });
  return { layer, out, api };
}

const baseFlags: BranchesUnpauseFlags = {
  name: Option.none(),
  projectRef: Option.none(),
};

describe("branches unpause integration", () => {
  it.effect("unpauses a branch given a project-ref pattern", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(api.requests.find((r) => r.method === "POST")?.url).toContain(
        `/v1/projects/${BRANCH_REF}/restore`,
      );
      expect(sequence(api.requests)).toEqual([`POST ${API}/v1/projects/${BRANCH_REF}/restore`]);
      assertPermissionDrift({ command: "branches unpause", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves a UUID through the branch config before unpausing", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.sync(() =>
          request.method === "GET" && request.url === `${API}/v1/branches/${BRANCH_UUID}`
            ? jsonResponse(request, 200, {
                ref: BRANCH_REF,
                postgres_version: "15",
                postgres_engine: "15",
                release_channel: "ga",
                status: "ACTIVE_HEALTHY",
                db_host: `db.${BRANCH_REF}.supabase.co`,
                db_port: 5432,
              })
            : jsonResponse(request, 200, null),
        ),
    });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    });
    return Effect.gen(function* () {
      yield* branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(sequence(api.requests)).toEqual([
        `GET ${API}/v1/branches/${BRANCH_UUID}`,
        `POST ${API}/v1/projects/${BRANCH_REF}/restore`,
      ]);
      assertPermissionDrift({ command: "branches unpause", requests: api.requests });
    }).pipe(Effect.provide(layer));
  });

  it.effect("is silent on stdout/stderr on success", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesUnpauseUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ restoreStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesUnpauseUnexpectedStatusError");
        expect(causeText).toContain("unexpected unpause branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("carries the plan-gate entitlement on a JSON-mode gated restore", () => {
    const upgradeUrl = "https://supabase.com/dashboard/org/acme/billing";
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.sync(() =>
          jsonResponse(request, 402, {
            message: "Restoring this project requires a paid plan",
            error: {
              code: "entitlement_required",
              feature: "project_restore_size",
              upgrade_url: upgradeUrl,
            },
          }),
        ),
    });
    const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
    const layer = buildTestRuntime({ out, api, cliSettings });
    return Effect.gen(function* () {
      yield* branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) }).pipe(
        withJsonErrorHandling,
      );
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0]).toMatchObject({
        code: "BranchesUnpauseUnexpectedStatusError",
        entitlement: { feature: "project_restore_size", upgrade_url: upgradeUrl },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "unpauses the branch chosen from the pickers and fills the real linked-project cache",
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
            if (
              request.method === "POST" &&
              request.url === `${API}/v1/projects/${BRANCH_REF}/restore`
            ) {
              return jsonResponse(request, 200, null);
            }
            return jsonResponse(request, 404, { message: "unexpected request" });
          }),
      });
      const cliSettings = mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
      const layer = buildTestRuntime({
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

        yield* branchesUnpause(baseFlags);

        expect(sequence(api.requests)).toEqual([
          `GET ${API}/v1/projects`,
          `GET ${API}/v1/projects/${VALID_REF}/branches`,
          `POST ${API}/v1/projects/${BRANCH_REF}/restore`,
          `GET ${API}/v1/projects/${VALID_REF}`,
        ]);
        expect(out.stderrText).toContain(`Selected branch ID: ${BRANCH_REF}`);
        expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
          ref: VALID_REF,
        });
        assertPermissionDrift({
          command: "branches unpause",
          requests: api.requests,
          exact: true,
        });
      }).pipe(Effect.provide(layer));
    },
  );
});
