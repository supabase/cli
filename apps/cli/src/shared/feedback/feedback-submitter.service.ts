import type { Effect } from "effect";
import { Context, Data } from "effect";

/** Environment details attached to every submission alongside the message. */
interface FeedbackContext {
  readonly cliVersion: string;
  readonly os: string;
  readonly arch: string;
  readonly isAgent: boolean;
  readonly agentName?: string;
}

export interface FeedbackSubmission {
  readonly message: string;
  readonly context: FeedbackContext;
}

interface FeedbackReceipt {
  readonly id: string;
  readonly submittedAt: string;
}

/**
 * Failure channel reserved for the real backend submitter (CLI-1946); the
 * stub layer never fails, but handlers and tests are wired for it already.
 */
export class FeedbackSubmitError extends Data.TaggedError("FeedbackSubmitError")<{
  readonly message: string;
}> {}

interface FeedbackSubmitterShape {
  readonly submit: (
    submission: FeedbackSubmission,
  ) => Effect.Effect<FeedbackReceipt, FeedbackSubmitError>;
}

export class FeedbackSubmitter extends Context.Service<FeedbackSubmitter, FeedbackSubmitterShape>()(
  "supabase/feedback/FeedbackSubmitter",
) {}
