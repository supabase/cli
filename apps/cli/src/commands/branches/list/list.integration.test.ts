import { describe, expect, it } from "@effect/vitest";
import { SupabaseApiClient } from "@supabase/api/effect";
import { Effect, Exit, Layer } from "effect";
import type { BranchResponse } from "@supabase/api/effect";
import { withJsonErrorHandling } from "../../../output/json-error-handling.ts";
import { emptyEnv, mockOutput, mockProjectLinkState } from "../../../../tests/helpers/mocks.ts";
import { list } from "./list.handler.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBranch(
  overrides: Partial<typeof BranchResponse.Type> = {},
): typeof BranchResponse.Type {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "main",
    project_ref: "mainrefghijklmnopqrst",
    parent_project_ref: "parentref1234567890",
    is_default: true,
    persistent: true,
    status: "MIGRATIONS_PASSED",
    created_at: "2024-01-15T10:30:00.000Z",
    updated_at: "2024-01-15T10:30:00.000Z",
    with_data: false,
    ...overrides,
  };
}

const DEFAULT_LINK_STATE = {
  project: {
    ref: "parentref1234567890",
    name: "my-project",
    organization_id: "org123",
    organization_slug: "my-org",
  },
  active_branch: {
    ref: "mainrefghijklmnopqrst",
    name: "main",
    is_default: true,
  },
  fetchedAt: "2024-01-01T00:00:00.000Z",
  versions: {},
};

function mockApiClient(branches: ReadonlyArray<typeof BranchResponse.Type>) {
  return Layer.succeed(SupabaseApiClient, {
    execute: () => Effect.succeed(branches) as never,
  });
}

function setup(
  opts: {
    branches?: ReadonlyArray<typeof BranchResponse.Type>;
    linked?: boolean;
    format?: "text" | "json" | "stream-json";
  } = {},
) {
  const linked = opts.linked ?? true;
  const out = mockOutput({ format: opts.format ?? "text" });
  const linkState = mockProjectLinkState(linked ? DEFAULT_LINK_STATE : undefined);
  const api = mockApiClient(opts.branches ?? [makeBranch()]);
  const layer = Layer.mergeAll(emptyEnv(), out.layer, linkState, api);
  return { out, layer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("branches list handler", () => {
  it.live(
    "marks the active branch with (active) suffix and emits date/time on separate lines",
    () =>
      Effect.gen(function* () {
        const devBranch = makeBranch({
          id: "00000000-0000-0000-0000-000000000002",
          name: "dev",
          project_ref: "devrefghijklmnopqrst",
          is_default: false,
        });
        const { out, layer } = setup({ branches: [makeBranch(), devBranch] });

        yield* list().pipe(Effect.provide(layer));

        const infoMessages = out.messages.filter((m) => m.type === "info").map((m) => m.message);

        // Active branch row shows "(active)" suffix
        expect(infoMessages.some((m) => m.includes("main (active)"))).toBe(true);
        // Non-active branch row shows plain name only
        expect(infoMessages.some((m) => m.includes("dev") && !m.includes("(active)"))).toBe(true);
        // Date and time are in the same message but on separate visual lines via \n
        expect(
          infoMessages.some((m) => m.includes("2024-01-15") && m.includes("10:30:00 UTC")),
        ).toBe(true);
      }),
  );

  it.live("shows no (active) suffix when no branch ref matches", () =>
    Effect.gen(function* () {
      const branch = makeBranch({ project_ref: "someotherref12345678" });
      const { out, layer } = setup({ branches: [branch] });

      yield* list().pipe(Effect.provide(layer));

      const infoMessages = out.messages.filter((m) => m.type === "info").map((m) => m.message);

      expect(infoMessages.some((m) => m.includes("(active)"))).toBe(false);
    }),
  );

  it.live("fails with ProjectNotLinkedError when project is not linked", () =>
    Effect.gen(function* () {
      const { layer } = setup({ linked: false });

      const exit = yield* list().pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const cause = exit.cause;
        expect(JSON.stringify(cause)).toContain("ProjectNotLinkedError");
        expect(JSON.stringify(cause)).toContain("supabase link");
      }
    }),
  );

  it.live("emits a success event with branches array in JSON mode", () =>
    Effect.gen(function* () {
      const { out, layer } = setup({ format: "json" });

      yield* list().pipe(Effect.provide(layer));

      const successMessages = out.messages.filter((m) => m.type === "success");
      expect(successMessages).toHaveLength(1);
      const data = (successMessages[0] as { data?: { branches?: unknown[] } }).data;
      expect(data?.branches).toHaveLength(1);
      expect(data?.branches?.[0]).toMatchObject({ active: true, name: "main" });
    }),
  );

  it.live("sets active:false for non-active branches in JSON mode", () =>
    Effect.gen(function* () {
      const devBranch = makeBranch({
        id: "00000000-0000-0000-0000-000000000002",
        name: "dev",
        project_ref: "devrefghijklmnopqrst",
        is_default: false,
      });
      const { out, layer } = setup({ branches: [makeBranch(), devBranch], format: "json" });

      yield* list().pipe(Effect.provide(layer));

      const data = (
        out.messages.find((m) => m.type === "success") as {
          data?: { branches?: Array<{ active: boolean; name: string }> };
        }
      )?.data;
      const devEntry = data?.branches?.find((b) => b.name === "dev");
      expect(devEntry?.active).toBe(false);
    }),
  );

  it.live("outputs outro with no branches found when list is empty", () =>
    Effect.gen(function* () {
      const { out, layer } = setup({ branches: [] });

      yield* list().pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "outro", message: "No branches found." }),
      );
    }),
  );

  it.live("emits a fail event for API errors in JSON mode", () =>
    Effect.gen(function* () {
      const out = mockOutput({ format: "json" });
      const linkState = mockProjectLinkState(DEFAULT_LINK_STATE);
      const failingApiClient = Layer.succeed(SupabaseApiClient, {
        execute: () => Effect.fail(new Error("API unavailable") as never),
      });
      const layer = Layer.mergeAll(emptyEnv(), out.layer, linkState, failingApiClient);

      yield* list().pipe(withJsonErrorHandling, Effect.provide(layer));

      expect(out.messages).toContainEqual(expect.objectContaining({ type: "fail" }));
    }),
  );
});
