import type { Effect, Option } from "effect";
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

/**
 * Returned once per submission: the server-generated token that authorizes
 * deleting the row later. Never persisted by the CLI — shown to the user and
 * then forgotten.
 */
interface FeedbackSubmitReceipt {
  readonly deleteToken: string;
}

/** A rejected request (PostgREST error) or a failed/timed-out network call. */
export class FeedbackBackendError extends Data.TaggedError("FeedbackBackendError")<{
  readonly message: string;
  readonly operation: "submit" | "preview" | "delete";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Both branches (PostgREST rejection, network failure/timeout) are
    // failures of the external feedback backend, not user mistakes.
    return actionability.externalNetwork;
  }
}

interface FeedbackClientShape {
  readonly submit: (
    submission: FeedbackSubmission,
  ) => Effect.Effect<FeedbackSubmitReceipt, FeedbackBackendError>;
  /**
   * The feedback text of the row the token unlocks, or `None` when no row
   * matches (wrong token, already deleted, or a project-ref context mismatch —
   * the backend cannot distinguish these).
   */
  readonly preview: (
    token: string,
    projectRef?: string,
  ) => Effect.Effect<Option.Option<string>, FeedbackBackendError>;
  /** `deleted: false` means the delete matched zero rows (same causes as `preview` → `None`). */
  readonly delete: (
    token: string,
    projectRef?: string,
  ) => Effect.Effect<{ readonly deleted: boolean }, FeedbackBackendError>;
}

export class FeedbackClient extends Context.Service<FeedbackClient, FeedbackClientShape>()(
  "supabase/feedback/FeedbackClient",
) {}
