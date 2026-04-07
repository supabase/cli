import { describe, expect, it } from "@effect/vitest";
import { SupabaseApiClient } from "@supabase/api/effect";
import { Effect, Exit, Layer, Option } from "effect";
import type { BranchResponse } from "@supabase/api/effect";
import { withJsonErrorHandling } from "../../../output/json-error-handling.ts";
import { emptyEnv, mockOutput, mockProjectLinkState } from "../../../../tests/helpers/mocks.ts";
import { switchBranch } from "./switch.handler.ts";

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

const MAIN_BRANCH = makeBranch();
const DEV_BRANCH = makeBranch({
  id: "00000000-0000-0000-0000-000000000002",
  name: "dev",
  project_ref: "devrefghijklmnopqrst0",
  is_default: false,
});

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
    interactive?: boolean;
    promptSelectResponses?: ReadonlyArray<string>;
    activeBranchRef?: string;
  } = {},
) {
  const linked = opts.linked ?? true;
  const activeBranch = opts.activeBranchRef
    ? { ref: opts.activeBranchRef, name: "main", is_default: true }
    : DEFAULT_LINK_STATE.active_branch;
  const linkState = linked ? { ...DEFAULT_LINK_STATE, active_branch: activeBranch } : undefined;

  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: opts.interactive ?? (opts.format ?? "text") === "text",
    promptSelectResponses: opts.promptSelectResponses,
  });
  const state = mockProjectLinkState(linkState);
  const api = mockApiClient(opts.branches ?? [MAIN_BRANCH, DEV_BRANCH]);
  const layer = Layer.mergeAll(emptyEnv(), out.layer, state, api);
  return { out, state, layer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("branches switch handler", () => {
  it.live("switches to a branch by name", () =>
    Effect.gen(function* () {
      const { out, layer } = setup();

      yield* switchBranch({ name: Option.some("dev") }).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "outro", message: "Switched to branch 'dev'." }),
      );
    }),
  );

  it.live("switches to a branch by project_ref", () =>
    Effect.gen(function* () {
      const { out, layer } = setup();

      yield* switchBranch({ name: Option.some("devrefghijklmnopqrst0") }).pipe(
        Effect.provide(layer),
      );

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "outro", message: "Switched to branch 'dev'." }),
      );
    }),
  );

  it.live("shows interactive select when no name is provided", () =>
    Effect.gen(function* () {
      const { out, layer } = setup({
        interactive: true,
        promptSelectResponses: ["devrefghijklmnopqrst0"],
      });

      yield* switchBranch({ name: Option.none() }).pipe(Effect.provide(layer));

      expect(out.promptSelectCalls).toHaveLength(1);
      expect(out.promptSelectCalls[0]?.options.map((o) => o.label)).toContain("dev");
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "outro", message: "Switched to branch 'dev'." }),
      );
    }),
  );

  it.live("fails with NonInteractiveError when no name and not interactive", () =>
    Effect.gen(function* () {
      const { layer } = setup({ interactive: false });

      const exit = yield* switchBranch({ name: Option.none() }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("NonInteractiveError");
      }
    }),
  );

  it.live("shows 'already on branch' when target is already active", () =>
    Effect.gen(function* () {
      const { out, layer } = setup();

      yield* switchBranch({ name: Option.some("main") }).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "outro", message: "Already on branch 'main'." }),
      );
    }),
  );

  it.live("fails with BranchNotFoundError when name does not match any branch", () =>
    Effect.gen(function* () {
      const { layer } = setup();

      const exit = yield* switchBranch({ name: Option.some("nonexistent") }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("BranchNotFoundError");
        expect(JSON.stringify(exit.cause)).toContain("nonexistent");
      }
    }),
  );

  it.live("fails with ProjectNotLinkedError when project is not linked", () =>
    Effect.gen(function* () {
      const { layer } = setup({ linked: false });

      const exit = yield* switchBranch({ name: Option.some("dev") }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("ProjectNotLinkedError");
        expect(JSON.stringify(exit.cause)).toContain("supabase link");
      }
    }),
  );

  it.live("emits success event with branch data in JSON mode", () =>
    Effect.gen(function* () {
      const { out, layer } = setup({ format: "json" });

      yield* switchBranch({ name: Option.some("dev") }).pipe(Effect.provide(layer));

      const successMessages = out.messages.filter((m) => m.type === "success");
      expect(successMessages).toHaveLength(1);
      const data = (successMessages[0] as { data?: { branch?: unknown } }).data;
      expect(data?.branch).toMatchObject({
        ref: "devrefghijklmnopqrst0",
        name: "dev",
        is_default: false,
      });
    }),
  );

  it.live("emits success event when already on branch in JSON mode", () =>
    Effect.gen(function* () {
      const { out, layer } = setup({ format: "json" });

      yield* switchBranch({ name: Option.some("main") }).pipe(Effect.provide(layer));

      // Already on branch — no success event, just outro
      const successMessages = out.messages.filter((m) => m.type === "success");
      expect(successMessages).toHaveLength(0);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "outro", message: "Already on branch 'main'." }),
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

      yield* switchBranch({ name: Option.some("dev") }).pipe(
        withJsonErrorHandling,
        Effect.provide(layer),
      );

      expect(out.messages).toContainEqual(expect.objectContaining({ type: "fail" }));
    }),
  );

  it.live("skips stack lifecycle when no local stack is running", () =>
    Effect.gen(function* () {
      const { out, layer } = setup();

      yield* switchBranch({ name: Option.some("dev") }).pipe(Effect.provide(layer));

      expect(out.messages).not.toContainEqual(
        expect.objectContaining({ type: "info", message: expect.stringContaining("detach mode") }),
      );
    }),
  );
});
