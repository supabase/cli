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
  /**
   * Gotrue user UUID (persisted telemetry distinct_id); absent when not
   * logged in or when telemetry consent is denied.
   */
  readonly userId?: string;
  readonly context: FeedbackContext;
}

/** A rejected insert (PostgREST error) or a failed/timed-out network call. */
export class FeedbackSubmitError extends Data.TaggedError("FeedbackSubmitError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

interface FeedbackSubmitterShape {
  readonly submit: (submission: FeedbackSubmission) => Effect.Effect<void, FeedbackSubmitError>;
}

export class FeedbackSubmitter extends Context.Service<FeedbackSubmitter, FeedbackSubmitterShape>()(
  "supabase/feedback/FeedbackSubmitter",
) {}
