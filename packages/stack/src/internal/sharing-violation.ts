import { Duration, Effect, Predicate, Schedule } from "effect";

/** The errno code a platform error carries on its cause, when it has one. */
export const errorCode = (error: unknown): string | undefined => {
  if (!Predicate.hasProperty(error, "cause")) return undefined;
  return Predicate.hasProperty(error.cause, "code") && typeof error.cause.code === "string"
    ? error.cause.code
    : undefined;
};

/** Windows reports a file that another process holds or replaces as a transient sharing violation. */
const isSharingViolation =
  (platform: NodeJS.Platform = process.platform) =>
  (error: unknown): boolean =>
    platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "");

const sharingViolationSchedule = Schedule.exponential("10 millis", 2).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.millis(100))),
  ),
  Schedule.upTo({ times: 12 }),
);

/** Retries a file operation with bounded backoff while it fails with a sharing violation. */
export const retrySharingViolation =
  (platform?: NodeJS.Platform) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.retry({ schedule: sharingViolationSchedule, while: isSharingViolation(platform) }),
    );
