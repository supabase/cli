import { Effect, Layer } from "effect";
import { FeedbackSubmitter } from "./feedback-submitter.service.ts";

/**
 * Local no-op submitter: acknowledges receipt without any network I/O. The
 * backend destination for CLI feedback is undecided (CLI-1946); once chosen,
 * replace this layer with the real submitter — the handler and its error
 * channel are already wired for the swap.
 */
export const feedbackSubmitterStubLayer = Layer.succeed(
  FeedbackSubmitter,
  FeedbackSubmitter.of({
    submit: () =>
      Effect.sync(() => ({
        id: crypto.randomUUID(),
        submittedAt: new Date().toISOString(),
      })),
  }),
);
