import { describe, expect, it } from "@effect/vitest";
import { makeApiClient } from "@supabase/api/effect";
import { Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { BranchResponse } from "@supabase/api/effect";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { emptyEnv, mockOutput, mockProjectLinkState } from "../../../../../tests/helpers/mocks.ts";
import { ProjectLinkState } from "../../../config/project-link-state.service.ts";
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
  project_ref: "devrefghijklmnopqrst",
  is_default: false,
});

const DEFAULT_LINK_STATE = {
  project: {
    ref: "parentrefabcdefghijk",
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

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

function jsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
      },
    }),
  );
}

function mockPlatformApi(
  branches: ReadonlyArray<typeof BranchResponse.Type>,
  opts: { status?: number } = {},
) {
  const requests: Array<{
    url: string;
    headers: Readonly<Record<string, string | undefined>>;
  }> = [];

  const layer = Layer.effect(
    PlatformApi,
    makeApiClient({
      baseUrl: "https://api.supabase.com",
      accessToken: "test-token",
      userAgent: "supabase",
      headers: {
        "X-Supabase-Command": "branches switch",
        "X-Supabase-Command-Run-ID": "run-123",
      },
    }),
  ).pipe(
    Layer.provide(
      httpClientLayer((request) => {
        requests.push({
          url: request.url,
          headers: request.headers,
        });
        return Effect.succeed(jsonResponse(request, opts.status ?? 200, branches));
      }),
    ),
  );

  return {
    layer,
    get requests() {
      return requests;
    },
  };
}

function setup(
  opts: {
    branches?: ReadonlyArray<typeof BranchResponse.Type>;
    linked?: boolean;
    format?: "text" | "json" | "stream-json";
    interactive?: boolean;
    promptSelectResponses?: ReadonlyArray<string>;
    activeBranchRef?: string;
    status?: number;
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
  const api = mockPlatformApi(opts.branches ?? [MAIN_BRANCH, DEV_BRANCH], {
    status: opts.status,
  });
  const layer = Layer.mergeAll(emptyEnv(), out.layer, state, api.layer);
  return { out, layer, api };
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

  it.live("updates the active branch in link state after switching", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* switchBranch({ name: Option.some("dev") });
      const linkStateService = yield* ProjectLinkState;
      const state = yield* linkStateService.load;
      const activeBranch = Option.map(state, (s) => s.active_branch);
      expect(Option.getOrNull(activeBranch)?.ref).toBe("devrefghijklmnopqrst");
      expect(Option.getOrNull(activeBranch)?.name).toBe("dev");
    }).pipe(Effect.provide(layer));
  });

  it.live("switches to a branch by project_ref", () =>
    Effect.gen(function* () {
      const { out, layer } = setup();

      yield* switchBranch({ name: Option.some("devrefghijklmnopqrst") }).pipe(
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
        promptSelectResponses: ["devrefghijklmnopqrst"],
      });

      yield* switchBranch({ name: Option.none() }).pipe(Effect.provide(layer));

      expect(out.promptSelectCalls).toHaveLength(1);
      expect(out.promptSelectCalls[0]?.options.map((option) => option.label)).toContain("dev");
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "outro", message: "Switched to branch 'dev'." }),
      );
    }),
  );

  it.live(
    "fails with BranchNotFoundError when interactive select returns an unresolvable ref",
    () =>
      Effect.gen(function* () {
        const { layer } = setup({
          interactive: true,
          promptSelectResponses: ["ghost-ref-that-doesnt-exist"],
        });

        const exit = yield* switchBranch({ name: Option.none() }).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("BranchNotFoundError");
          expect(JSON.stringify(exit.cause)).toContain("Selected branch could not be resolved");
        }
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

      const successMessages = out.messages.filter((message) => message.type === "success");
      expect(successMessages).toHaveLength(1);
      const data = (successMessages[0] as { data?: { branch?: unknown } }).data;
      expect(data?.branch).toMatchObject({
        ref: "devrefghijklmnopqrst",
        name: "dev",
        is_default: false,
      });
    }),
  );

  it.live("emits outro but no success event when already on branch in JSON mode", () =>
    Effect.gen(function* () {
      const { out, layer } = setup({ format: "json" });

      yield* switchBranch({ name: Option.some("main") }).pipe(Effect.provide(layer));

      const successMessages = out.messages.filter((message) => message.type === "success");
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
      const api = mockPlatformApi([MAIN_BRANCH, DEV_BRANCH], { status: 503 });
      const layer = Layer.mergeAll(emptyEnv(), out.layer, linkState, api.layer);

      yield* switchBranch({ name: Option.some("dev") }).pipe(
        withJsonErrorHandling,
        Effect.provide(layer),
      );

      expect(out.messages).toContainEqual(expect.objectContaining({ type: "fail" }));
    }),
  );

  it.live("calls the facade client with the expected CLI headers", () =>
    Effect.gen(function* () {
      const { api, layer } = setup({ format: "json" });

      yield* switchBranch({ name: Option.some("dev") }).pipe(Effect.provide(layer));

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toBe(
        "https://api.supabase.com/v1/projects/parentrefabcdefghijk/branches",
      );
      expect(api.requests[0]?.headers["x-supabase-command"]).toBe("branches switch");
      expect(api.requests[0]?.headers["x-supabase-command-run-id"]).toBe("run-123");
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
