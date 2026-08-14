import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Option } from "effect";
import { feedbackClientLayer } from "./feedback-client.layer.ts";
import type { FeedbackSubmission } from "./feedback-client.service.ts";
import { FeedbackClient } from "./feedback-client.service.ts";

// The layer only needs a url/key shape — no request leaves the test, so the
// values are arbitrary.
const TEST_ENV = {
  url: "https://feedback-project.supabase.co",
  key: "sb_publishable_test_key",
};

const TOKEN = "123e4567-e89b-12d3-a456-426614174000";
const PROJECT_REF = "abcdefghijklmnopqrst";
const USER_ID = "11111111-2222-3333-4444-555555555555";

const SUBMISSION: FeedbackSubmission = {
  message: "port conflicts when running two stacks",
  projectRef: PROJECT_REF,
  userId: USER_ID,
  context: {
    cliVersion: "9.9.9",
    userAgent: "SupabaseCLI/9.9.9",
    os: "darwin",
    arch: "arm64",
    isAgent: true,
    agentName: "claude_code",
  },
};

// A recording fetch injected through supabase-js's `global.fetch` option — the
// PostgREST request goes through this instead of the network. `preconnect` is
// part of Bun's `typeof fetch` and must exist on the impostor too.
function recordingFetch(
  respond: (request: Request) => Response | Promise<Response> = () =>
    new Response(null, { status: 201 }),
) {
  const requests: Array<{ request: Request; bodyText: string }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      requests.push({ request, bodyText: await request.clone().text() });
      return respond(request);
    },
    { preconnect: () => Promise.resolve() },
  );
  return { fetch, requests };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function layerWith(transport: ReturnType<typeof recordingFetch>) {
  return feedbackClientLayer({ environment: TEST_ENV, fetch: transport.fetch });
}

describe("feedbackClientLayer", () => {
  describe("submit", () => {
    it.live("submits through the RPC and returns the server-issued delete token", () => {
      const transport = recordingFetch(() => jsonResponse(TOKEN));
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const receipt = yield* client.submit(SUBMISSION);

        expect(receipt).toEqual({ deleteToken: TOKEN });
        expect(transport.requests).toHaveLength(1);
        const { request, bodyText } = transport.requests[0]!;
        expect(request.method).toBe("POST");
        expect(request.url).toBe(`${TEST_ENV.url}/rest/v1/rpc/submit_interfaces_feedback`);
        expect(request.headers.get("apikey")).toBe(TEST_ENV.key);
        expect(JSON.parse(bodyText)).toEqual({
          feedback: "port conflicts when running two stacks",
          user_agent: "SupabaseCLI/9.9.9",
          project_ref: PROJECT_REF,
          user_id: USER_ID,
          metadata: {
            cli_version: "9.9.9",
            source: "cli",
            os: "darwin",
            arch: "arm64",
            is_agent: true,
            agent_name: "claude_code",
          },
        });
      }).pipe(Effect.provide(layerWith(transport)));
    });

    it.live("omits project_ref and agent_name for an unlinked non-agent run", () => {
      const transport = recordingFetch(() => jsonResponse(TOKEN));
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        yield* client.submit({
          message: "no project linked",
          context: {
            cliVersion: "9.9.9",
            userAgent: "SupabaseCLI/9.9.9",
            os: "linux",
            arch: "x64",
            isAgent: false,
          },
        });

        const body = JSON.parse(transport.requests[0]!.bodyText);
        // The RPC's `project_ref` parameter defaults to null server-side; the
        // CLI simply leaves it (and `user_id`) out of the call.
        expect(body).not.toHaveProperty("project_ref");
        expect(body).not.toHaveProperty("user_id");
        expect(body.metadata).toEqual({
          cli_version: "9.9.9",
          source: "cli",
          os: "linux",
          arch: "x64",
          is_agent: false,
        });
      }).pipe(Effect.provide(layerWith(transport)));
    });

    it.live("maps a PostgREST error response to FeedbackBackendError", () => {
      // Shape PostgREST returns when execute is denied on the RPC.
      const transport = recordingFetch(() =>
        jsonResponse(
          {
            message: "permission denied for function submit_interfaces_feedback",
            code: "42501",
            details: null,
            hint: null,
          },
          401,
        ),
      );
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const error = yield* client.submit(SUBMISSION).pipe(Effect.flip);

        expect(error._tag).toBe("FeedbackBackendError");
        expect(error.operation).toBe("submit");
        expect(error.message).toContain("permission denied");
      }).pipe(Effect.provide(layerWith(transport)));
    });

    it.live("maps a network failure to FeedbackBackendError", () => {
      const transport = recordingFetch(() => {
        throw new Error("network down");
      });
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const error = yield* client.submit(SUBMISSION).pipe(Effect.flip);

        expect(error._tag).toBe("FeedbackBackendError");
        expect(error.operation).toBe("submit");
      }).pipe(Effect.provide(layerWith(transport)));
    });

    it.live("aborts the in-flight request when the fiber is interrupted", () => {
      // Ctrl-C during submission must abort the HTTP request, not let the
      // insert commit after the command was cancelled. The fake fetch behaves
      // like a real one: it settles only when its abort signal fires.
      let capturedSignal: AbortSignal | undefined;
      const inFlight = Promise.withResolvers<void>();
      const transport = recordingFetch((request) => {
        capturedSignal = request.signal;
        inFlight.resolve();
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        });
      });
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const fiber = yield* client
          .submit(SUBMISSION)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => inFlight.promise);
        yield* Fiber.interrupt(fiber);

        expect(capturedSignal?.aborted).toBe(true);
      }).pipe(Effect.provide(layerWith(transport)));
    });

    it.live("fails when the backend returns no delete token", () => {
      const transport = recordingFetch(() => jsonResponse(null));
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const error = yield* client.submit(SUBMISSION).pipe(Effect.flip);

        expect(error._tag).toBe("FeedbackBackendError");
        expect(error.message).toContain("no delete token");
      }).pipe(Effect.provide(layerWith(transport)));
    });
  });

  describe("preview", () => {
    it.live("requests the feedback text with the token filter and capability headers", () => {
      const transport = recordingFetch(() => jsonResponse([{ feedback: "my papercut" }]));
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const preview = yield* client.preview(TOKEN, { projectRef: PROJECT_REF, userId: USER_ID });

        expect(preview).toEqual(Option.some("my papercut"));
        const { request } = transport.requests[0]!;
        expect(request.method).toBe("GET");
        const url = new URL(request.url);
        expect(url.pathname).toBe("/rest/v1/interfaces_feedback");
        expect(url.searchParams.get("select")).toBe("feedback");
        expect(url.searchParams.get("delete_token")).toBe(`eq.${TOKEN}`);
        expect(request.headers.get("apikey")).toBe(TEST_ENV.key);
        expect(request.headers.get("x-feedback-token")).toBe(TOKEN);
        expect(request.headers.get("x-feedback-project-ref")).toBe(PROJECT_REF);
        expect(request.headers.get("x-feedback-user-id")).toBe(USER_ID);
      }).pipe(Effect.provide(layerWith(transport)));
    });

    it.live("sends no context headers when no ref or user id is provided", () => {
      const transport = recordingFetch(() => jsonResponse([{ feedback: "context-free" }]));
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        yield* client.preview(TOKEN);

        const { request } = transport.requests[0]!;
        expect(request.headers.get("x-feedback-token")).toBe(TOKEN);
        expect(request.headers.has("x-feedback-project-ref")).toBe(false);
        expect(request.headers.has("x-feedback-user-id")).toBe(false);
      }).pipe(Effect.provide(layerWith(transport)));
    });

    it.live("returns None when the token matches no row", () => {
      const transport = recordingFetch(() => jsonResponse([]));
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const preview = yield* client.preview(TOKEN, { projectRef: PROJECT_REF });

        expect(Option.isNone(preview)).toBe(true);
      }).pipe(Effect.provide(layerWith(transport)));
    });

    // A thrown-fetch variant would work too, but postgrest-js retries
    // idempotent GETs on network errors with ~7s of backoff — a non-retryable
    // PostgREST error response exercises the same mapping without the wait.
    it.live("maps a PostgREST error response to FeedbackBackendError", () => {
      const transport = recordingFetch(() =>
        jsonResponse(
          { message: "canceling statement due to statement timeout", code: "57014" },
          500,
        ),
      );
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const error = yield* client.preview(TOKEN).pipe(Effect.flip);

        expect(error._tag).toBe("FeedbackBackendError");
        expect(error.operation).toBe("preview");
      }).pipe(Effect.provide(layerWith(transport)));
    });
  });

  describe("delete", () => {
    it.live("deletes with the token filter, capability headers, and an exact count", () => {
      const transport = recordingFetch(
        () => new Response(null, { status: 204, headers: { "content-range": "*/1" } }),
      );
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const result = yield* client.delete(TOKEN, { projectRef: PROJECT_REF, userId: USER_ID });

        expect(result).toEqual({ deleted: true });
        const { request } = transport.requests[0]!;
        expect(request.method).toBe("DELETE");
        const url = new URL(request.url);
        expect(url.pathname).toBe("/rest/v1/interfaces_feedback");
        expect(url.searchParams.get("delete_token")).toBe(`eq.${TOKEN}`);
        expect(request.headers.get("prefer")).toContain("count=exact");
        expect(request.headers.get("x-feedback-token")).toBe(TOKEN);
        expect(request.headers.get("x-feedback-project-ref")).toBe(PROJECT_REF);
        expect(request.headers.get("x-feedback-user-id")).toBe(USER_ID);
      }).pipe(Effect.provide(layerWith(transport)));
    });

    it.live("reports deleted: false when the delete matched zero rows", () => {
      // Wrong/stale token or a project-ref/user-id context mismatch: RLS
      // matches nothing and PostgREST reports an empty range.
      const transport = recordingFetch(
        () => new Response(null, { status: 204, headers: { "content-range": "*/0" } }),
      );
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const result = yield* client.delete(TOKEN);

        expect(result).toEqual({ deleted: false });
        expect(transport.requests[0]!.request.headers.has("x-feedback-project-ref")).toBe(false);
        expect(transport.requests[0]!.request.headers.has("x-feedback-user-id")).toBe(false);
      }).pipe(Effect.provide(layerWith(transport)));
    });

    it.live("maps a network failure to FeedbackBackendError", () => {
      const transport = recordingFetch(() => {
        throw new Error("network down");
      });
      return Effect.gen(function* () {
        const client = yield* FeedbackClient;
        const error = yield* client.delete(TOKEN).pipe(Effect.flip);

        expect(error._tag).toBe("FeedbackBackendError");
        expect(error.operation).toBe("delete");
      }).pipe(Effect.provide(layerWith(transport)));
    });
  });
});
