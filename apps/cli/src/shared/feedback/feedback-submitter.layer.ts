import { createClient } from "@supabase/supabase-js";
import { Effect, Layer } from "effect";
import type { Database, TablesInsert } from "./database.types.ts";
import type { FeedbackEnvironment } from "./feedback-config.ts";
import type { FeedbackSubmission } from "./feedback-submitter.service.ts";
import { FeedbackSubmitError, FeedbackSubmitter } from "./feedback-submitter.service.ts";

const SUBMIT_TIMEOUT_MS = 10_000;

export interface FeedbackSubmitterOptions {
  readonly environment: FeedbackEnvironment;
  /** Injectable transport for hermetic tests, like `legacyDohFetch`'s `innerFetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

function toInsertRow(submission: FeedbackSubmission): TablesInsert<"interfaces_feedback"> {
  const { context } = submission;
  return {
    feedback: submission.message,
    source: "cli",
    user_agent: context.userAgent,
    project_ref: submission.projectRef ?? null,
    metadata: {
      cli_version: context.cliVersion,
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
