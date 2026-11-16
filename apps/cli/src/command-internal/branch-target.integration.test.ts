import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { jsonResponse, mockCommandPlatformApi } from "../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { assertBlockDrift } from "../../tests/helpers/permission-drift.ts";
import { branchTarget, findBranchName } from "./branch-target.ts";

const PARENT_REF = "abcdefghijklmnopqrst";
const BRANCH_REF = "cccccccccccccccccccc";
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";

const BRANCHES: typeof V1ListAllBranchesOutput.Type = [
  {
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
  },
];

function setup(listing: { readonly status: number; readonly body: unknown }) {
  const api = mockCommandPlatformApi({
    handler: (request) => Effect.sync(() => jsonResponse(request, listing.status, listing.body)),
  });
  const out = mockOutput({ format: "text" });
  return { api, layer: Layer.mergeAll(api.layer, out.layer) };
}

describe("findBranchName integration", () => {
  it.effect("lists the parent project's branches and returns the linked branch's name", () => {
    const { api, layer } = setup({ status: 200, body: BRANCHES });
    return Effect.gen(function* () {
      const name = yield* findBranchName(PARENT_REF, BRANCH_REF);
      expect(name).toBe("feat-x");
      expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${PARENT_REF}/branches`,
      ]);
      assertBlockDrift(branchTarget, {
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns undefined without throwing when the listing request fails", () => {
    const { api, layer } = setup({ status: 403, body: { message: "forbidden" } });
    return Effect.gen(function* () {
      const name = yield* findBranchName(PARENT_REF, BRANCH_REF);
      expect(api.requests).toHaveLength(1);
      expect(name).toBeUndefined();
      assertBlockDrift(branchTarget, {
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });
});
