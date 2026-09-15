import { Cause, Data, Effect, Exit, Schedule, Schema } from "effect";
import { expect } from "vitest";

import {
  experimentalProjectLiveFlags,
  type LiveFixtures,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

type LiveCliEffect = LiveFixtures["cliEffect"];
type LiveRun = Awaited<ReturnType<LiveFixtures["cli"]>>;

// Bound the polled gets and the restore so one hung subprocess cannot exhaust
// the live testTimeout and leave the shared project with a flipped posture.
const POLL_ATTEMPT_EXIT_TIMEOUT_MS = 20_000;
const RESTORE_EXIT_TIMEOUT_MS = 60_000;
const PROOF_INTERVAL_MS = 2_000;
const PROOF_TIMEOUT_MS = 60_000;
// Fits the worst case (bounded capture/toggle + two proofs + restore) with headroom.
const LIVE_TIMEOUT_MS = 600_000;

const SslEnforcementPosture = Schema.Struct({
  currentConfig: Schema.Struct({ database: Schema.Boolean }),
  appliedSuccessfully: Schema.Boolean,
});

/** Typed proof failures keep the poll retrying transient exits and unpropagated reads alike. */
class SslEnforcementLiveError extends Data.TaggedError("SslEnforcementLiveError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function enforcementFlag(enforce: boolean): string {
  return enforce ? "--enable-db-ssl-enforcement" : "--disable-db-ssl-enforcement";
}

function requireSuccess(result: LiveRun, label: string) {
  return Effect.try({
    try: () => {
      requireLiveSuccess(result, label);
    },
    catch: (error) =>
      new SslEnforcementLiveError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      }),
  });
}

function readPosture(
  cliEffect: LiveCliEffect,
  flags: ReadonlyArray<string>,
  label: string,
  exitTimeoutMs?: number,
) {
  return Effect.gen(function* () {
    const result = yield* cliEffect(["ssl-enforcement", "get", ...flags, "-o", "json"], {
      exitTimeoutMs,
    });
    yield* requireSuccess(result, label);
    if (result.stdout === "") {
      return yield* new SslEnforcementLiveError({
        message: `${label}: printed nothing on stdout\nstderr:\n${result.stderr}`,
      });
    }
    return yield* Schema.decodeEffect(Schema.fromJsonString(SslEnforcementPosture))(result.stdout, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new SslEnforcementLiveError({
            message: `${label}: unexpected ssl-enforcement get payload\n${result.stdout}`,
            cause: error,
          }),
      ),
    );
  });
}

// get reports `appliedSuccessfully: false` until the posture propagates (see
// ../get/SIDE_EFFECTS.md), and there is no signal to wait on, so poll get (bounded).
const proofSchedule = Schedule.spaced(PROOF_INTERVAL_MS).pipe(
  Schedule.upTo({ duration: PROOF_TIMEOUT_MS }),
);

function expectApplied(
  cliEffect: LiveCliEffect,
  flags: ReadonlyArray<string>,
  enforce: boolean,
  label: string,
) {
  const expected = { currentConfig: { database: enforce }, appliedSuccessfully: true };
  return readPosture(cliEffect, flags, label, POLL_ATTEMPT_EXIT_TIMEOUT_MS).pipe(
    Effect.flatMap((posture) =>
      Effect.try({
        try: () => expect(posture, label).toEqual(expected),
        catch: (error) =>
          new SslEnforcementLiveError({
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
      }),
    ),
    Effect.retry(proofSchedule),
    Effect.asVoid,
  );
}

// Not wired to the test `signal`: an interrupt SIGKILLs an in-flight restore
// mid-request (the run's scope release kills the process group), so letting the
// bounded restore run out is strictly safer.
test(
  "toggles enforcement, get proves it, and restores the captured posture",
  { timeout: LIVE_TIMEOUT_MS },
  ({ cliEffect, project }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const flags = experimentalProjectLiveFlags(project);
        const captured = yield* readPosture(
          cliEffect,
          flags,
          "ssl-enforcement get capture for ssl-enforcement update",
          RESTORE_EXIT_TIMEOUT_MS,
        );
        const posture = captured.currentConfig.database;

        const toggle = Effect.gen(function* () {
          const updated = yield* cliEffect(
            ["ssl-enforcement", "update", enforcementFlag(!posture), ...flags, "-o", "json"],
            { exitTimeoutMs: RESTORE_EXIT_TIMEOUT_MS },
          );
          expect(updated.exitCode, updated.stderr).toBe(0);
          expect(updated.stdout, updated.stderr).not.toBe("");
          const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
            updated.stdout,
          );
          expect(payload, updated.stdout).toMatchObject({
            currentConfig: { database: !posture },
          });

          yield* expectApplied(
            cliEffect,
            flags,
            !posture,
            "ssl-enforcement get proof for ssl-enforcement update",
          );
        });

        const restore = Effect.gen(function* () {
          const restored = yield* cliEffect(
            ["ssl-enforcement", "update", enforcementFlag(posture), ...flags],
            { exitTimeoutMs: RESTORE_EXIT_TIMEOUT_MS },
          );
          yield* requireSuccess(restored, "ssl-enforcement update restore of the captured posture");
          yield* expectApplied(
            cliEffect,
            flags,
            posture,
            "ssl-enforcement get proof of the restored posture for ssl-enforcement update",
          );
        });

        // The restore runs whatever the toggle did; neither failure hides the other.
        const toggleExit = yield* Effect.exit(toggle);
        const restoreExit = yield* Effect.exit(restore);
        return {
          toggleError: Exit.isFailure(toggleExit) ? Cause.squash(toggleExit.cause) : undefined,
          restoreErrors: Exit.isFailure(restoreExit) ? [Cause.squash(restoreExit.cause)] : [],
        };
      }),
    ).then(({ toggleError, restoreErrors }) => throwWithCleanup(toggleError, restoreErrors)),
);
