import { createClient } from "@supabase/supabase-js";
import { Effect, Layer } from "effect";
import type { Database, TablesInsert } from "./database.types.ts";
import type { FeedbackSubmission } from "./feedback-submitter.service.ts";
import { FeedbackSubmitError, FeedbackSubmitter } from "./feedback-submitter.service.ts";

/**
 * Feedback backend connection config. The keys are publishable (anon) keys,
 * safe to commit — writes are gated by insert-only RLS on the
 * `interfaces_feedback` table, exactly like the docs feedback widget.
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

const SUBMIT_TIMEOUT_MS = 10_000;

interface FeedbackSubmitterOptions {
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

function toInsertRow(submission: FeedbackSubmission): TablesInsert<"interfaces_feedback"> {
  const { context } = submission;
  return {
    feedback: submission.message,
    user_agent: context.userAgent,
    project_ref: submission.projectRef ?? null,
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

export function feedbackSubmitterLayer(
  options: FeedbackSubmitterOptions,
): Layer.Layer<FeedbackSubmitter> {
  return Layer.sync(FeedbackSubmitter, () => {
    const client = createClient<Database>(options.environment.url, options.environment.key, {
      auth: { persistSession: false },
      global: options.fetch === undefined ? {} : { fetch: options.fetch },
    });

    return FeedbackSubmitter.of({
      submit: (submission) =>
        Effect.tryPromise({
          try: () =>
            client
              .from("interfaces_feedback")
              .insert(toInsertRow(submission))
              .abortSignal(AbortSignal.timeout(SUBMIT_TIMEOUT_MS)),
          catch: (cause) =>
            new FeedbackSubmitError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(
          // PostgREST reports failures as a returned `error`, not a rejection.
          Effect.flatMap(({ error }) =>
            error === null
              ? Effect.void
              : Effect.fail(new FeedbackSubmitError({ message: error.message })),
          ),
        ),
    });
  });
}
