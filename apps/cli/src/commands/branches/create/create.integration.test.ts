import { describe, expect, it } from "@effect/vitest";
import { makeApiClient, V1CreateABranchOutput } from "@supabase/api/effect";
import { Effect, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { ProjectLinkState } from "../../../config/project-link-state.service.ts";
import { withJsonErrorHandling } from "../../../output/json-error-handling.ts";
import {
  emptyEnv,
  mockOutput,
  mockProjectLinkState,
  withEnv,
} from "../../../../tests/helpers/mocks.ts";
import type { CreateFlags } from "./create.command.ts";
import { create } from "./create.handler.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder();

function makeCreatedBranch(
  overrides: Partial<typeof V1CreateABranchOutput.Type> = {},
): typeof V1CreateABranchOutput.Type {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    name: "feature-branch",
    project_ref: "branchrefabcdefghijk",
    parent_project_ref: "parentrefabcdefghijk",
    is_default: false,
    persistent: false,
    status: "CREATING_PROJECT",
    created_at: "2024-03-01T12:00:00.000Z",
    updated_at: "2024-03-01T12:00:00.000Z",
    with_data: false,
    ...overrides,
  };
}

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

const BASE_FLAGS: CreateFlags = {
  name: Option.none(),
  region: Option.none(),
  size: Option.none(),
  persistent: false,
  withData: false,
  notifyUrl: Option.none(),
  switchAfter: true,
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

function requestBodyJson(
  request: HttpClientRequest.HttpClientRequest,
): Record<string, unknown> | undefined {
  if (request.body._tag !== "Uint8Array") {
    return undefined;
  }
  return JSON.parse(textDecoder.decode(request.body.body)) as Record<string, unknown>;
}

function mockCreateApi(
  opts: {
    response?: typeof V1CreateABranchOutput.Type;
    status?: number;
  } = {},
) {
  let capturedInput: Record<string, unknown> | undefined;

  const layer = Layer.effect(
    PlatformApi,
    makeApiClient({
      baseUrl: "https://api.supabase.com",
      accessToken: "test-token",
      userAgent: "@supabase/cli",
      headers: {
        "X-Supabase-Command": "branches create",
        "X-Supabase-Command-Run-ID": "run-123",
      },
    }),
  ).pipe(
    Layer.provide(
      httpClientLayer((request) => {
        capturedInput = requestBodyJson(request);
        return Effect.succeed(
          jsonResponse(request, opts.status ?? 200, opts.response ?? makeCreatedBranch()),
        );
      }),
    ),
  );

  return {
    layer,
    get capturedInput() {
      return capturedInput;
    },
  };
}

function setup(
  opts: {
    env?: Record<string, string>;
    linked?: boolean;
    format?: "text" | "json" | "stream-json";
    interactive?: boolean;
    confirmCreate?: boolean;
    apiResponse?: typeof V1CreateABranchOutput.Type;
    apiStatus?: number;
  } = {},
) {
  const linked = opts.linked ?? true;
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: opts.interactive,
    confirmRelogin: opts.confirmCreate,
  });
  const linkState = mockProjectLinkState(linked ? DEFAULT_LINK_STATE : undefined);
  const api = mockCreateApi({ response: opts.apiResponse, status: opts.apiStatus });
  const base = opts.env ? withEnv(opts.env) : emptyEnv();
  const layer = Layer.mergeAll(base, out.layer, linkState, api.layer);
  return { out, layer, api };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("branches create handler", () => {
  it.live("creates a branch with an explicit name and renders table in text mode", () =>
    Effect.gen(function* () {
      const branch = makeCreatedBranch({ name: "my-branch" });
      const { out, layer } = setup({ apiResponse: branch });
      const flags: CreateFlags = { ...BASE_FLAGS, name: Option.some("my-branch") };

      yield* create(flags).pipe(Effect.provide(layer));

      const infoMessages = out.messages.filter((m) => m.type === "info").map((m) => m.message);
      expect(infoMessages.some((m) => m.includes("my-branch"))).toBe(true);
      expect(infoMessages.some((m) => m.includes("2024-03-01") && m.includes("12:00:00 UTC"))).toBe(
        true,
      );
      expect(
        out.messages.some(
          (m) =>
            m.type === "outro" &&
            m.message.includes("my-branch") &&
            m.message.includes("created and set as active"),
        ),
      ).toBe(true);
    }),
  );

  it.live("prompts for git branch confirmation when no name is provided (interactive)", () =>
    Effect.gen(function* () {
      const branch = makeCreatedBranch({
        name: "feature/auto-detect",
        git_branch: "feature/auto-detect",
      });
      const { out, layer, api } = setup({
        env: { GITHUB_HEAD_REF: "feature/auto-detect" },
        apiResponse: branch,
        confirmCreate: true,
      });

      yield* create(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(out.messages.some((m) => m.message.includes("feature/auto-detect"))).toBe(true);
      expect(api.capturedInput?.branch_name).toBe("feature/auto-detect");
      expect(api.capturedInput?.git_branch).toBe("feature/auto-detect");
    }),
  );

  it.live("fails with NoBranchNameError when git branch prompt is declined", () =>
    Effect.gen(function* () {
      const { layer } = setup({
        env: { GITHUB_HEAD_REF: "feature/some-branch" },
        confirmCreate: false,
      });

      const exit = yield* create(BASE_FLAGS).pipe(Effect.provide(layer), Effect.exit);

      expect(JSON.stringify(exit)).toContain("NoBranchNameError");
      expect(JSON.stringify(exit)).toContain("cancelled");
    }),
  );

  it.live("fails with NoBranchNameError when no name and no git branch", () =>
    Effect.gen(function* () {
      const { layer } = setup();

      const exit = yield* create(BASE_FLAGS).pipe(Effect.provide(layer), Effect.exit);

      expect(JSON.stringify(exit)).toContain("NoBranchNameError");
      expect(JSON.stringify(exit)).toContain("supabase branches create");
    }),
  );

  it.live("auto-uses git branch without prompting in non-interactive mode", () =>
    Effect.gen(function* () {
      const branch = makeCreatedBranch({ name: "feature/ci-branch" });
      const { layer, api } = setup({
        env: { GITHUB_HEAD_REF: "feature/ci-branch" },
        format: "json",
        apiResponse: branch,
      });

      yield* create(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(api.capturedInput?.branch_name).toBe("feature/ci-branch");
      expect(api.capturedInput?.git_branch).toBe("feature/ci-branch");
    }),
  );

  it.live("fails with NoBranchNameError in non-interactive mode when no git branch", () =>
    Effect.gen(function* () {
      const { layer } = setup({ format: "json" });

      const exit = yield* create(BASE_FLAGS).pipe(Effect.provide(layer), Effect.exit);

      expect(JSON.stringify(exit)).toContain("NoBranchNameError");
    }),
  );

  it.live("fails with ProjectNotLinkedError when project is not linked", () =>
    Effect.gen(function* () {
      const { layer } = setup({ linked: false });
      const flags: CreateFlags = { ...BASE_FLAGS, name: Option.some("my-branch") };

      const exit = yield* create(flags).pipe(Effect.provide(layer), Effect.exit);

      expect(JSON.stringify(exit)).toContain("ProjectNotLinkedError");
      expect(JSON.stringify(exit)).toContain("supabase link");
    }),
  );

  it.live("emits a fail event for API errors in JSON mode", () =>
    Effect.gen(function* () {
      const { out, layer } = setup({
        format: "json",
        apiStatus: 503,
      });
      const flags: CreateFlags = { ...BASE_FLAGS, name: Option.some("my-branch") };

      yield* create(flags).pipe(withJsonErrorHandling, Effect.provide(layer));

      expect(out.messages).toContainEqual(expect.objectContaining({ type: "fail" }));
    }),
  );

  it.live("emits a success event with branch data in JSON mode", () =>
    Effect.gen(function* () {
      const branch = makeCreatedBranch({ name: "json-branch" });
      const { out, layer } = setup({ format: "json", apiResponse: branch });
      const flags: CreateFlags = { ...BASE_FLAGS, name: Option.some("json-branch") };

      yield* create(flags).pipe(Effect.provide(layer));

      const successMessages = out.messages.filter((m) => m.type === "success");
      expect(successMessages).toHaveLength(1);
      const data = (successMessages[0] as { data?: { name?: string } }).data;
      expect(data?.name).toBe("json-branch");
    }),
  );

  it.live("forwards optional flags to the API call", () =>
    Effect.gen(function* () {
      const { layer, api } = setup();
      const flags: CreateFlags = {
        name: Option.some("flagged-branch"),
        region: Option.some("us-east-1"),
        size: Option.some("medium"),
        persistent: true,
        withData: true,
        notifyUrl: Option.some("https://example.com/hook"),
        switchAfter: false,
      };

      yield* create(flags).pipe(Effect.provide(layer));

      expect(api.capturedInput?.region).toBe("us-east-1");
      expect(api.capturedInput?.desired_instance_size).toBe("medium");
      expect(api.capturedInput?.persistent).toBe(true);
      expect(api.capturedInput?.with_data).toBe(true);
      expect(api.capturedInput?.notify_url).toBe("https://example.com/hook");
    }),
  );

  it.live("does not send falsey branch creation flags to the API", () =>
    Effect.gen(function* () {
      const { layer, api } = setup();
      const flags: CreateFlags = { ...BASE_FLAGS, name: Option.some("my-branch") };

      yield* create(flags).pipe(Effect.provide(layer));

      expect(api.capturedInput?.persistent).toBeUndefined();
      expect(api.capturedInput?.with_data).toBeUndefined();
    }),
  );

  it.live("sets active branch to the newly created branch by default", () => {
    const branch = makeCreatedBranch({
      name: "new-active-branch",
      project_ref: "newbranchrefabcdefgh",
      is_default: false,
    });
    const { layer } = setup({ apiResponse: branch });
    const flags: CreateFlags = { ...BASE_FLAGS, name: Option.some("new-active-branch") };

    return Effect.gen(function* () {
      yield* create(flags);

      const projectLinkState = yield* ProjectLinkState;
      const state = yield* projectLinkState.load;
      const activeBranch = Option.map(state, (linkState) => linkState.active_branch);
      expect(Option.getOrNull(activeBranch)?.ref).toBe("newbranchrefabcdefgh");
      expect(Option.getOrNull(activeBranch)?.name).toBe("new-active-branch");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps API 409 responses to BranchAlreadyExistsError for auto-detected git branches", () =>
    Effect.gen(function* () {
      const { layer } = setup({
        env: { GITHUB_HEAD_REF: "existing-branch" },
        apiStatus: 409,
        format: "json",
      });

      const exit = yield* create(BASE_FLAGS).pipe(Effect.provide(layer), Effect.exit);

      expect(JSON.stringify(exit)).toContain("BranchAlreadyExistsError");
      expect(JSON.stringify(exit)).toContain("supabase branches create <name>");
    }),
  );

  it.live("maps API 409 responses to BranchAlreadyExistsError for explicit names", () =>
    Effect.gen(function* () {
      const { layer } = setup({ apiStatus: 409 });
      const flags: CreateFlags = { ...BASE_FLAGS, name: Option.some("existing-branch") };

      const exit = yield* create(flags).pipe(Effect.provide(layer), Effect.exit);

      expect(JSON.stringify(exit)).toContain("BranchAlreadyExistsError");
      expect(JSON.stringify(exit)).toContain("existing-branch");
    }),
  );

  it.live("does not switch and shows switch hint when --no-switch is passed", () => {
    const branch = makeCreatedBranch({
      name: "no-switch-branch",
      project_ref: "noswitchref123456789",
      is_default: false,
    });
    const { layer, out } = setup({ apiResponse: branch });
    const flags: CreateFlags = {
      ...BASE_FLAGS,
      name: Option.some("no-switch-branch"),
      switchAfter: false,
    };

    return Effect.gen(function* () {
      yield* create(flags);
      const linkStateService = yield* ProjectLinkState;
      const state = yield* linkStateService.load;
      // Active branch remains unchanged
      expect(Option.getOrNull(Option.map(state, (s) => s.active_branch))?.ref).toBe(
        "mainrefghijklmnopqrst",
      );
      expect(
        out.messages.some(
          (m) =>
            m.type === "outro" && m.message.includes("supabase branches switch no-switch-branch"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
