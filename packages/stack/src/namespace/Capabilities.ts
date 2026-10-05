import { Duration, Effect, Predicate, Schedule, Schema } from "effect";

/** A failure from any namespace operation; `operation` names the step that failed. */
export class NamespaceError extends Schema.TaggedError<NamespaceError>()(
  "Namespace.NamespaceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export const namespaceError = (operation: string, cause: unknown): NamespaceError =>
  new NamespaceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** The `code` of a `PlatformError`-shaped `{ cause: { code } }`, or of any error that cause wraps. */
export const errorCode = (error: unknown): string | undefined => {
  if (!Predicate.hasProperty(error, "cause")) return undefined;
  return Predicate.hasProperty(error.cause, "code") && typeof error.cause.code === "string"
    ? error.cause.code
    : undefined;
};
/** Windows reports a file another process is still using or replacing as a transient violation. */
export const isSharingViolation =
  (platform: NodeJS.Platform) =>
  (error: unknown): boolean =>
    platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "");

/** Shared bounded backoff for retrying a transient Windows sharing violation. */
export const transientRetrySchedule = Schedule.exponential("10 millis", 2).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.millis(100))),
  ),
  Schedule.upTo({ times: 12 }),
);

/** Retries a read against `transientRetrySchedule` while it hits a sharing violation on `platform`. */
export const retryTransientRead =
  (platform?: NodeJS.Platform) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.retry({
        schedule: transientRetrySchedule,
        while: isSharingViolation(platform ?? process.platform),
      }),
    );
