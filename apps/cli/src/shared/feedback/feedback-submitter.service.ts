import type { Effect } from "effect";
import { Context, Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/** Environment details attached to every submission alongside the message. */
interface FeedbackContext {
  readonly cliVersion: string;
  readonly userAgent: string;
  readonly os: string;
  readonly arch: string;
  readonly isAgent: boolean;
  readonly agentName?: string;
}

export interface FeedbackSubmission {
  readonly message: string;
  readonly projectRef?: string;
  readonly context: FeedbackContext;
}

/** A rejected insert (PostgREST error) or a failed/timed-out network call. */
export class FeedbackSubmitError extends Data.TaggedError("FeedbackSubmitError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Both branches (PostgREST rejection, network failure/timeout) are
    // failures of the external feedback backend, not user mistakes.
    return actionability.externalNetwork;
  }
}

interface FeedbackSubmitterShape {
  readonly submit: (submission: FeedbackSubmission) => Effect.Effect<void, FeedbackSubmitError>;
}

export class FeedbackSubmitter extends Context.Service<FeedbackSubmitter, FeedbackSubmitterShape>()(
  "supabase/feedback/FeedbackSubmitter",
) {}
