import { createClient } from "@supabase/supabase-js";
import { Effect, Layer, Option } from "effect";
import type { Database } from "./database.types.ts";
import type { FeedbackSubmission } from "./feedback-client.service.ts";
import { FeedbackBackendError, FeedbackClient } from "./feedback-client.service.ts";

/**
 * Feedback backend connection config. The keys are publishable (anon) keys,
 * safe to commit. Submissions go exclusively through the SECURITY DEFINER
 * `submit_interfaces_feedback` RPC (there is no insert grant on the table),
 * which returns a server-generated delete token exactly once. Reads and
 * deletes are gated by RLS policies that compare the row's `delete_token`
 * against the `x-feedback-token` request header — plus a matching
 * `x-feedback-project-ref` header when the row was submitted with one.
 */
interface FeedbackEnvironment {
  readonly url: string;
  readonly key: string;
}

const FEEDBACK_STAGING: FeedbackEnvironment = {
  url: "https://imrwaufzgcaczqmpnxyr.supabase.co",
  key: "sb_publishable_puOyAlqG5J_XfBMTDM2Ckw_L5mieFdb",
};

// No dedicated production feedback project exists yet (CLI-1946): production
// intentionally reuses the staging values until one is provisioned.
const FEEDBACK_PRODUCTION: FeedbackEnvironment = { ...FEEDBACK_STAGING };

const REQUEST_TIMEOUT_MS = 10_000;

interface FeedbackClientOptions {
  readonly environment: FeedbackEnvironment;
  /** Injectable transport for hermetic tests, like `legacyDohFetch`'s `innerFetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

// Profile → feedback environment, mirroring how the Management API url follows
// the resolved profile: staging profiles post to the staging project, with a
// production fallback for unknown and YAML-file profiles (`legacy-profile.ts`).
export function legacyFeedbackEnvironment(profile: string): FeedbackEnvironment {
  switch (profile) {
    case "supabase-staging":
    case "supabase-local":
      return FEEDBACK_STAGING;
    default:
      return FEEDBACK_PRODUCTION;
  }
}

type RpcArgs = Database["public"]["Functions"]["submit_interfaces_feedback"]["Args"];

// `user_id` is deliberately never sent: the CLI has no user-scoped identity in
// this flow, and omitting it keeps the row's delete authorization token-only.
function toRpcArgs(submission: FeedbackSubmission): RpcArgs {
  const { context } = submission;
  return {
    feedback: submission.message,
    user_agent: context.userAgent,
    ...(submission.projectRef === undefined ? {} : { project_ref: submission.projectRef }),
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

export function feedbackClientLayer(options: FeedbackClientOptions): Layer.Layer<FeedbackClient> {
  return Layer.sync(FeedbackClient, () => {
    const client = createClient<Database>(options.environment.url, options.environment.key, {
      auth: { persistSession: false },
      global: options.fetch === undefined ? {} : { fetch: options.fetch },
    });

    // PostgREST reports failures as a returned `error`, not a rejection; a
    // thrown/timed-out fetch rejects. Both map to `FeedbackBackendError`.
    const run = <A>(
      operation: FeedbackBackendError["operation"],
      request: () => PromiseLike<{
        data: A;
        error: { message: string } | null;
        count?: number | null;
      }>,
    ) =>
      Effect.tryPromise({
        try: request,
        catch: (cause) =>
          new FeedbackBackendError({
            message: cause instanceof Error ? cause.message : String(cause),
            operation,
          }),
      }).pipe(
        Effect.flatMap((response) =>
          response.error === null
            ? Effect.succeed(response)
            : Effect.fail(new FeedbackBackendError({ message: response.error.message, operation })),
        ),
      );

    return FeedbackClient.of({
      submit: (submission) =>
        run("submit", () =>
          client
            .rpc("submit_interfaces_feedback", toRpcArgs(submission))
            .abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
        ).pipe(
          Effect.flatMap(({ data }) =>
            typeof data === "string" && data.length > 0
              ? Effect.succeed({ deleteToken: data })
              : Effect.fail(
                  new FeedbackBackendError({
                    message: "feedback backend returned no delete token",
                    operation: "submit",
                  }),
                ),
          ),
        ),

      preview: (token, projectRef) =>
        run("preview", () => {
          const request = client
            .from("interfaces_feedback")
            .select("feedback")
            .eq("delete_token", token)
            .setHeader("x-feedback-token", token)
            .abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
          return projectRef === undefined
            ? request
            : request.setHeader("x-feedback-project-ref", projectRef);
        }).pipe(Effect.map(({ data }) => Option.fromNullishOr(data?.[0]?.feedback))),

      delete: (token, projectRef) =>
        run("delete", () => {
          // The `delete_token=eq.` filter satisfies PostgREST's filterless-delete
          // rejection; the `x-feedback-token` header is the actual security
          // boundary (RLS matches zero rows without it). `count: "exact"` asks
          // for a Content-Range so the caller can tell a matched delete from a
          // zero-row one.
          const request = client
            .from("interfaces_feedback")
            .delete({ count: "exact" })
            .eq("delete_token", token)
            .setHeader("x-feedback-token", token)
            .abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
          return projectRef === undefined
            ? request
            : request.setHeader("x-feedback-project-ref", projectRef);
        }).pipe(Effect.map(({ count }) => ({ deleted: count === 1 }))),
    });
  });
}
