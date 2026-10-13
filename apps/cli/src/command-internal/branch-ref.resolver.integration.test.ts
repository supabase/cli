import type { V1GetABranchConfigOutput, V1GetABranchOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { jsonResponse, mockCommandPlatformApi } from "../../tests/helpers/command-mocks.ts";
import { assertDriftAgainst } from "../../tests/helpers/permission-drift.ts";
import { resolveBranchProjectRef } from "./branch-ref.resolver.ts";
import { branchRef } from "./command-permissions/fragments.ts";
import { mapped } from "./command-permissions/model.ts";

const branchRefDeclared = { _tag: "Declared", permissions: mapped(branchRef) } as const;

const PARENT_REF = "abcdefghijklmnopqrst";
const BRANCH_REF = "cccccccccccccccccccc";
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";

const DETAIL: typeof V1GetABranchConfigOutput.Type = {
  ref: BRANCH_REF,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "db.cccccccccccccccccccc.supabase.co",
  db_port: 5432,
};

const FOUND: typeof V1GetABranchOutput.Type = {
  id: BRANCH_UUID,
  name: "feat-x",
  project_ref: BRANCH_REF,
  parent_project_ref: PARENT_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  with_data: false,
};

const mappers = {
  mapGetError: () => Effect.die("unexpected branch-id lookup failure"),
  mapFindError: () => Effect.die("unexpected branch-name lookup failure"),
};

function setup() {
  return mockCommandPlatformApi({
    handler: (request) =>
      Effect.sync(() =>
        request.url.includes("/v1/branches/")
          ? jsonResponse(request, 200, DETAIL)
          : jsonResponse(request, 200, FOUND),
      ),
  });
}

describe("resolveBranchProjectRef integration", () => {
  it.effect("returns a project-ref-shaped input unchanged without calling the API", () => {
    const api = setup();
    return Effect.gen(function* () {
      const ref = yield* resolveBranchProjectRef(BRANCH_REF, PARENT_REF, mappers);
      expect(ref).toBe(BRANCH_REF);
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("resolves a branch UUID through the branch config lookup", () => {
    const api = setup();
    return Effect.gen(function* () {
      const ref = yield* resolveBranchProjectRef(BRANCH_UUID, PARENT_REF, mappers);
      expect(ref).toBe(BRANCH_REF);
      expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        `GET https://api.supabase.com/v1/branches/${BRANCH_UUID}`,
      ]);
      assertDriftAgainst(branchRefDeclared, {
        command: "branch-ref block",
        requests: api.requests,
      });
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("resolves a branch name under its parent project through the branch lookup", () => {
    const api = setup();
    return Effect.gen(function* () {
      const ref = yield* resolveBranchProjectRef("feat-x", PARENT_REF, mappers);
      expect(ref).toBe(BRANCH_REF);
      expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${PARENT_REF}/branches/feat-x`,
      ]);
      assertDriftAgainst(branchRefDeclared, {
        command: "branch-ref block",
        requests: api.requests,
      });
    }).pipe(Effect.provide(api.layer));
  });
});
