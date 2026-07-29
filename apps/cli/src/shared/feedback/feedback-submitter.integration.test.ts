import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FEEDBACK_STAGING, feedbackSubmitterLayer } from "./feedback-submitter.layer.ts";
import type { FeedbackSubmission } from "./feedback-submitter.service.ts";
import { FeedbackSubmitter } from "./feedback-submitter.service.ts";

const SUBMISSION: FeedbackSubmission = {
  message: "port conflicts when running two stacks",
  projectRef: "abcdefghijklmnopqrst",
  userId: "11111111-2222-3333-4444-555555555555",
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

describe("feedbackSubmitterLayer", () => {
  it.live("posts the submission as an interfaces_feedback row", () => {
    const transport = recordingFetch();
    const layer = feedbackSubmitterLayer({
      environment: FEEDBACK_STAGING,
      fetch: transport.fetch,
    });
    return Effect.gen(function* () {
      const submitter = yield* FeedbackSubmitter;
      yield* submitter.submit(SUBMISSION);

      expect(transport.requests).toHaveLength(1);
      const { request, bodyText } = transport.requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.url).toBe(`${FEEDBACK_STAGING.url}/rest/v1/interfaces_feedback`);
      expect(request.headers.get("apikey")).toBe(FEEDBACK_STAGING.key);
      expect(JSON.parse(bodyText)).toEqual({
        feedback: "port conflicts when running two stacks",
        source: "cli",
        user_agent: "SupabaseCLI/9.9.9",
        project_ref: "abcdefghijklmnopqrst",
        user_id: "11111111-2222-3333-4444-555555555555",
        metadata: {
          cli_version: "9.9.9",
          os: "darwin",
          arch: "arm64",
          is_agent: true,
          agent_name: "claude_code",
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends null project_ref and no agent_name for an unlinked non-agent run", () => {
    const transport = recordingFetch();
    const layer = feedbackSubmitterLayer({
      environment: FEEDBACK_STAGING,
      fetch: transport.fetch,
    });
    return Effect.gen(function* () {
      const submitter = yield* FeedbackSubmitter;
      yield* submitter.submit({
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
      expect(body.project_ref).toBeNull();
      expect(body.user_id).toBeNull();
      expect(body.metadata).toEqual({
        cli_version: "9.9.9",
        os: "linux",
        arch: "x64",
        is_agent: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("maps a PostgREST error response to FeedbackSubmitError", () => {
    // Shape PostgREST returns for an RLS denial.
    const transport = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            message: 'new row violates row-level security policy for table "interfaces_feedback"',
            code: "42501",
            details: null,
            hint: null,
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const layer = feedbackSubmitterLayer({
      environment: FEEDBACK_STAGING,
      fetch: transport.fetch,
    });
    return Effect.gen(function* () {
      const submitter = yield* FeedbackSubmitter;
      const error = yield* submitter.submit(SUBMISSION).pipe(Effect.flip);

      expect(error._tag).toBe("FeedbackSubmitError");
      expect(error.message).toContain("row-level security");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps a network failure to FeedbackSubmitError", () => {
    const transport = recordingFetch(() => {
      throw new Error("network down");
    });
    const layer = feedbackSubmitterLayer({
      environment: FEEDBACK_STAGING,
      fetch: transport.fetch,
    });
    return Effect.gen(function* () {
      const submitter = yield* FeedbackSubmitter;
      const error = yield* submitter.submit(SUBMISSION).pipe(Effect.flip);

      expect(error._tag).toBe("FeedbackSubmitError");
    }).pipe(Effect.provide(layer));
  });
});
