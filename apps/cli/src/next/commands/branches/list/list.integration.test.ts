import { describe, expect, it } from "@effect/vitest";
import { makeApiClient } from "@supabase/api/effect";
import { Effect, Exit, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { BranchResponse } from "@supabase/api/effect";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { emptyEnv, mockOutput, mockProjectLinkState } from "../../../../../tests/helpers/mocks.ts";
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
    parent_project_ref: "parentrefabcdefghijk",
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
        "X-Supabase-Command": "branches list",
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
    status?: number;
  } = {},
) {
  const linked = opts.linked ?? true;
  const out = mockOutput({ format: opts.format ?? "text" });
  const linkState = mockProjectLinkState(linked ? DEFAULT_LINK_STATE : undefined);
  const api = mockPlatformApi(opts.branches ?? [makeBranch()], { status: opts.status });
  const layer = Layer.mergeAll(emptyEnv(), out.layer, linkState, api.layer);
  return { out, layer, api };
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

        expect(infoMessages.some((m) => m.includes("main (active)"))).toBe(true);
        expect(infoMessages.some((m) => m.includes("dev") && !m.includes("(active)"))).toBe(true);
        expect(
          infoMessages.some((m) => m.includes("2024-01-15") && m.includes("10:30:00 UTC")),
        ).toBe(true);
      }),
  );

  it.live("shows no (active) suffix when no branch ref matches", () =>
    Effect.gen(function* () {
      const branch = makeBranch({ project_ref: "someotherrefabcdefgh" });
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
      const { out, layer } = setup({ format: "json", status: 503 });

      yield* list().pipe(withJsonErrorHandling, Effect.provide(layer));

      expect(out.messages).toContainEqual(expect.objectContaining({ type: "fail" }));
    }),
  );

  it.live("calls the facade client with the expected CLI headers", () =>
    Effect.gen(function* () {
      const { api, layer } = setup({ format: "json" });

      yield* list().pipe(Effect.provide(layer));

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toBe(
        "https://api.supabase.com/v1/projects/parentrefabcdefghijk/branches",
      );
      expect(api.requests[0]?.headers["x-supabase-command"]).toBe("branches list");
      expect(api.requests[0]?.headers["x-supabase-command-run-id"]).toBe("run-123");
    }),
  );
});
