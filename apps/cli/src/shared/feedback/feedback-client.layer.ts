import { Effect, Layer, Option, Schema } from "effect";
import type { Database } from "./database.types.ts";
import type { FeedbackSubmission } from "./feedback-client.service.ts";
import { FeedbackBackendError, FeedbackClient } from "./feedback-client.service.ts";

/**
 * Feedback backend connection config. The keys are publishable (anon) keys,
 * safe to commit. Submissions go exclusively through the SECURITY DEFINER
 * `submit_interfaces_feedback` RPC (there is no insert grant on the table),
 * which returns a server-generated delete token exactly once. Deletes are
 * gated by an RLS policy that compares the row's `delete_token` against the
 * `x-feedback-token` request header — plus matching `x-feedback-project-ref`
 * / `x-feedback-user-id` headers when the row was submitted with them. The
 * CLI never reads a row; CLI-2406 removes the backend read path.
 */
interface FeedbackEnvironment {
  readonly url: string;
  readonly key: string;
}

const FEEDBACK_STAGING: FeedbackEnvironment = {
  url: "https://actixlblmrqglneypada.supabase.co",
  key: "sb_publishable_wLdx7w89KWFq-39s4emmnA__9XR9r-_",
};

const FEEDBACK_PRODUCTION: FeedbackEnvironment = {
  url: "https://xguihxuzqibwxjnimxev.supabase.co",
  key: "sb_publishable__4DBgvrDe7ec234wnvCAog_LPzBtkQe",
};

const REQUEST_TIMEOUT_MS = 10_000;

interface FeedbackClientOptions {
  readonly environment: FeedbackEnvironment;
  /**
   * Injectable transport. Production wires the debug/DoH fetch
   * (`feedbackFetch` in `feedback.layers.ts`) so `--debug` and
   * `--dns-resolver https` apply; hermetic tests inject a recording fake.
   */
  readonly fetch?: typeof globalThis.fetch;
}

// Profile → feedback environment, mirroring how the Management API url follows
// the resolved profile: staging profiles post to the persistent staging branch
// of the production feedback project, with a production fallback for unknown
// and YAML-file profiles (`profile-file.ts`).
export function feedbackEnvironment(profile: string): FeedbackEnvironment {
  switch (profile) {
    case "supabase-staging":
    case "supabase-local":
      return FEEDBACK_STAGING;
    default:
      return FEEDBACK_PRODUCTION;
  }
}

type RpcArgs = Database["public"]["Functions"]["submit_interfaces_feedback"]["Args"];

// `user_id` is the gotrue user UUID the handler read from the persisted
// telemetry identity — best-effort attribution, omitted when logged out or
// when telemetry consent is denied. A row submitted with it additionally
// requires the matching `x-feedback-user-id` header on delete (RLS).
function toRpcArgs(submission: FeedbackSubmission): RpcArgs {
  const { context } = submission;
  return {
    feedback: submission.message,
    user_agent: context.userAgent,
    ...(submission.projectRef === undefined ? {} : { project_ref: submission.projectRef }),
    ...(submission.userId === undefined ? {} : { user_id: submission.userId }),
    metadata: {
      cli_version: context.cliVersion,
      source: "cli",
      os: context.os,
      arch: context.arch,
      is_agent: context.isAgent,
      ...(context.agentName === undefined ? {} : { agent_name: context.agentName }),
    },
  };
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeDeleteToken = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));
const decodeErrorMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);

// `Content-Range: */<count>` from `Prefer: count=exact`; a missing header reads as no match.
function rangeCount(response: Response): number {
  const total = response.headers.get("content-range")?.split("/")[1];
  return total === undefined ? 0 : Number(total);
}

export function feedbackClientLayer(options: FeedbackClientOptions): Layer.Layer<FeedbackClient> {
  return Layer.sync(FeedbackClient, () => {
    const fetch = options.fetch ?? globalThis.fetch;
    const { url, key } = options.environment;

    // A thrown, timed-out, or aborted fetch is a transport failure; any non-2xx PostgREST answer
    // is a response failure. Each request aborts on whichever fires first: fiber interruption
    // (Ctrl-C must not let an in-flight submit commit after the command is cancelled) or the
    // 10s timeout.
    const request = (
      operation: FeedbackBackendError["operation"],
      path: string,
      init: {
        readonly method: string;
        readonly headers?: Record<string, string>;
        readonly body?: string;
      },
    ) =>
      Effect.tryPromise({
        try: (signal) =>
          fetch(`${url}/rest/v1/${path}`, {
            method: init.method,
            headers: { apikey: key, "content-type": "application/json", ...init.headers },
            ...(init.body === undefined ? {} : { body: init.body }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          }).then((response) => response.text().then((text) => ({ response, text }))),
        catch: (cause) =>
          new FeedbackBackendError({
            message: cause instanceof Error ? cause.message : String(cause),
            operation,
            reason: "transport",
          }),
      }).pipe(
        Effect.flatMap(({ response, text }) =>
          response.ok
            ? Effect.succeed({ response, text })
            : Effect.fail(
                new FeedbackBackendError({
                  message: decodeErrorMessage(text).pipe(
                    Option.map((body) => body.message),
                    Option.getOrElse(() => text || response.statusText),
                  ),
                  operation,
                  reason: "response",
                }),
              ),
        ),
      );

    return FeedbackClient.of({
      submit: Effect.fn("FeedbackClient.submit")(function* (submission) {
        const { text } = yield* request("submit", "rpc/submit_interfaces_feedback", {
          method: "POST",
          body: encodeJson(toRpcArgs(submission)),
        });
        const token = decodeDeleteToken(text).pipe(Option.filter((value) => value.length > 0));
        if (Option.isSome(token)) {
          return { deleteToken: token.value };
        }
        return yield* new FeedbackBackendError({
          message: "feedback backend returned no delete token",
          operation: "submit",
          reason: "response",
        });
      }),

      delete: Effect.fn("FeedbackClient.delete")(function* (token, context) {
        // The `delete_token=eq.` filter satisfies PostgREST's filterless-delete rejection; the
        // `x-feedback-token` header is the actual security boundary (RLS matches zero rows
        // without it). `count=exact` tells a matched delete from a zero-row one.
        const { response } = yield* request(
          "delete",
          `interfaces_feedback?delete_token=eq.${encodeURIComponent(token)}`,
          {
            method: "DELETE",
            headers: {
              prefer: "count=exact",
              "x-feedback-token": token,
              ...(context?.projectRef === undefined
                ? {}
                : { "x-feedback-project-ref": context.projectRef }),
              ...(context?.userId === undefined ? {} : { "x-feedback-user-id": context.userId }),
            },
          },
        );
        return { deleted: rangeCount(response) === 1 };
      }),
    });
  });
}
