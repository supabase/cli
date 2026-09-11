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

/**
 * Row-context values presented as `x-feedback-*` headers on delete. The RLS
 * policy requires each one when (and only when) the row was submitted with
 * it — extra context against a context-free row is ignored, so sending
 * whatever is available is always safe.
 */
interface FeedbackRowContext {
  readonly projectRef?: string;
  readonly userId?: string;
}

/**
 * Returned once per submission: the server-generated token that authorizes
 * deleting the row later. Never persisted by the CLI — shown to the user and
 * then forgotten.
 */
interface FeedbackSubmitReceipt {
  readonly deleteToken: string;
}

/**
 * A rejected request (PostgREST error response) or a failed/timed-out network
 * call. `reason` records which: the client sets `"response"` when the backend
 * answered with an error envelope (an HTTP status) and `"transport"` when the
 * fetch itself threw, timed out, or was aborted before any response arrived.
 */
export class FeedbackBackendError extends Data.TaggedError("FeedbackBackendError")<{
  readonly message: string;
  readonly operation: "submit" | "delete";
  readonly reason: "response" | "transport";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Both are failures of the external feedback backend, not user mistakes,
    // but they are different failures: an error the backend returned is an
    // API-status problem (a permission or validation rejection), while a
    // thrown/timed-out fetch is a network one. Same split every Management
    // API error class makes via its `decode`/`status` fields.
    return this.reason === "response"
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

interface FeedbackClientShape {
  readonly submit: (
    submission: FeedbackSubmission,
  ) => Effect.Effect<FeedbackSubmitReceipt, FeedbackBackendError>;
  /**
   * `deleted: false` means the delete matched zero rows: wrong token, already
   * deleted, or a project-ref/user-id context mismatch — the backend cannot
   * distinguish these. The CLI never reads a row (CLI-2406).
   */
  readonly delete: (
    token: string,
    context?: FeedbackRowContext,
  ) => Effect.Effect<{ readonly deleted: boolean }, FeedbackBackendError>;
}

export class FeedbackClient extends Context.Service<FeedbackClient, FeedbackClientShape>()(
  "supabase/feedback/FeedbackClient",
) {}
