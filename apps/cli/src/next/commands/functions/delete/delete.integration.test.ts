import { describe, expect, it } from "@effect/vitest";
import { makeApiClient } from "@supabase/api/effect";
import { Effect, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import {
  ProjectNotLinkedError,
  type ProjectLinkStateValue,
} from "../../../config/project-link-state.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { emptyEnv, mockOutput, mockProjectLinkState } from "../../../../../tests/helpers/mocks.ts";
import type { FunctionsDeleteFlags } from "./delete.command.ts";
import {
  DeleteFunctionNetworkError,
  DeleteFunctionUnexpectedStatusError,
  FunctionNotFoundError,
  InvalidFunctionSlugError,
} from "../../../../shared/functions/delete.errors.ts";
import { functionsDelete } from "./delete.handler.ts";

const PROJECT_REF = "abcdefghijklmnopqrst";
const BRANCH_REF = "branchrefabcdefghij";

const LINK_STATE: ProjectLinkStateValue = {
  project: {
    ref: PROJECT_REF,
    name: "Linked Project",
    organization_id: "org-id",
    organization_slug: "org-slug",
  },
  active_branch: {
    ref: BRANCH_REF,
    name: "main",
    is_default: true,
  },
  fetchedAt: "2026-01-01T00:00:00.000Z",
  versions: {},
};

const BASE_FLAGS: FunctionsDeleteFlags = {
  slug: "hello-world",
  projectRef: Option.none(),
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

function textResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body = "",
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status,
      headers: {
        "content-type": "text/plain",
      },
    }),
  );
}

function mockDeleteApi(opts: { status?: number; body?: string } = {}) {
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
        "X-Supabase-Command": "functions delete",
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
        return Effect.succeed(textResponse(request, opts.status ?? 200, opts.body ?? ""));
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
    linked?: boolean;
    format?: "text" | "json" | "stream-json";
    apiStatus?: number;
    apiBody?: string;
  } = {},
) {
  const out = mockOutput({ format: opts.format ?? "text", interactive: false });
  const api = mockDeleteApi({ status: opts.apiStatus, body: opts.apiBody });
  const layer = Layer.mergeAll(
    emptyEnv(),
    out.layer,
    mockProjectLinkState(opts.linked === false ? undefined : LINK_STATE),
    api.layer,
  );

  return { out, layer, api };
}

describe("functions delete", () => {
  it.live("deletes a function from the linked project in text mode", () =>
    Effect.gen(function* () {
      const { out, layer, api } = setup();

      yield* functionsDelete(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toBe(
        "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/functions/hello-world",
      );
      expect(api.requests[0]?.headers["x-supabase-command"]).toBe("functions delete");
      expect(out.stdoutText).toBe(
        "Deleted Function hello-world from project abcdefghijklmnopqrst.\n",
      );
    }),
  );

  it.live("uses an explicit --project-ref without requiring a linked project", () =>
    Effect.gen(function* () {
      const { out, layer, api } = setup({ linked: false });

      yield* functionsDelete({
        slug: "hello-world",
        projectRef: Option.some("qrstuvwxyzabcdefghij"),
      }).pipe(Effect.provide(layer));

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toBe(
        "https://api.supabase.com/v1/projects/qrstuvwxyzabcdefghij/functions/hello-world",
      );
      expect(out.stdoutText).toBe(
        "Deleted Function hello-world from project qrstuvwxyzabcdefghij.\n",
      );
    }),
  );

  it.live("fails when neither a linked project nor --project-ref is available", () =>
    Effect.gen(function* () {
      const { layer } = setup({ linked: false });

      const error = yield* functionsDelete(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(ProjectNotLinkedError);
    }),
  );

  it.live("fails for invalid function slugs before calling the API", () =>
    Effect.gen(function* () {
      const { layer, api } = setup();

      const error = yield* functionsDelete({
        slug: "hello.world",
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidFunctionSlugError);
      expect(api.requests).toHaveLength(0);
    }),
  );

  it.live("maps API 404 responses to FunctionNotFoundError", () =>
    Effect.gen(function* () {
      const { layer } = setup({ apiStatus: 404, apiBody: "not found" });

      const error = yield* functionsDelete(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(FunctionNotFoundError);
      expect(error.message).toBe(
        "Function hello-world does not exist on the Supabase project: nothing to delete",
      );
    }),
  );

  it.live("maps network failures to Go-style delete errors", () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        emptyEnv(),
        mockOutput({ format: "text", interactive: false }).layer,
        mockProjectLinkState(LINK_STATE),
        Layer.effect(
          PlatformApi,
          makeApiClient({
            baseUrl: "https://api.supabase.com",
            accessToken: "test-token",
            userAgent: "supabase",
            headers: {
              "X-Supabase-Command": "functions delete",
              "X-Supabase-Command-Run-ID": "run-123",
            },
          }),
        ).pipe(
          Layer.provide(
            httpClientLayer((request) =>
              Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new Error("network error"),
                    description: "network error",
                  }),
                }),
              ),
            ),
          ),
        ),
      );

      const error = yield* functionsDelete(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(DeleteFunctionNetworkError);
      expect(error.message).toBe("failed to delete function: network error");
    }),
  );

  it.live("maps unexpected statuses to Go-style delete errors", () =>
    Effect.gen(function* () {
      const { layer } = setup({ apiStatus: 503, apiBody: "unavailable" });

      const error = yield* functionsDelete(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(DeleteFunctionUnexpectedStatusError);
      expect(error.message).toBe("unexpected delete function status 503: unavailable");
    }),
  );

  it.live("emits a JSON failure payload instead of throwing in JSON mode", () =>
    Effect.gen(function* () {
      const { out, layer } = setup({ format: "json", apiStatus: 404, apiBody: "not found" });

      yield* functionsDelete(BASE_FLAGS).pipe(withJsonErrorHandling, Effect.provide(layer));

      expect(out.messages).toContainEqual(expect.objectContaining({ type: "fail" }));
    }),
  );

  it.live("emits structured success data in JSON mode", () =>
    Effect.gen(function* () {
      const { out, layer } = setup({ format: "json" });

      yield* functionsDelete(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Deleted Edge Function.",
          data: {
            function_slug: "hello-world",
            project_ref: PROJECT_REF,
          },
        }),
      );
    }),
  );
});
