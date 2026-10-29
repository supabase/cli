import { holdLock, isLockBusy } from "@supabase/stack/effect";
import { Clock, Data, Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { DebugLogger } from "../shared/output/debug-logger.service.ts";
import { aqua } from "./colors.ts";

const SUBJECT = "the start lock";
const NO_WAIT = "0 millis";
const WAIT_BUDGET = "10 minutes";
const WAITING_MESSAGE = "Waiting for another supabase start for this project to finish...\n";

/** Another `supabase start` for this project held the start lock for the whole wait budget. */
export class LocalStackStartBusyError extends Data.TaggedError("LocalStackStartBusyError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.startStack, fingerprint_suffix: "lease_held" };
  }
}

/**
 * Serialises `supabase start` and `supabase db start` per project for the enclosing scope. An
 * unwritable lock location never blocks a start; it continues unlocked.
 */
export const holdLocalStackStartLock = Effect.fn("LocalStack.startLock")(function* (
  projectId: string,
) {
  if (projectId.length === 0) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;
  const { supabaseHome } = yield* CommandSettings;
  const debugLogger = yield* Effect.serviceOption(DebugLogger);
  const locksDir = path.join(supabaseHome, "locks");
  const lockFile = path.join(locksDir, `start-${projectId}.lock`);
  const started = yield* Clock.currentTimeMillis;

  const record = (outcome: "acquired" | "busy" | "unavailable") =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.annotateCurrentSpan({ "lock.outcome": outcome, "lock.wait_ms": now - started }),
      ),
    );
  const continueUnlocked = (reason: string) =>
    (Option.isSome(debugLogger)
      ? debugLogger.value.debug(`Continuing without the start lock: ${reason}`)
      : Effect.void
    ).pipe(Effect.andThen(record("unavailable")));
  const waitForHolder = Effect.gen(function* () {
    if (output.format === "text") {
      yield* output.raw(WAITING_MESSAGE, "stderr");
    }
    yield* holdLock(lockFile, WAIT_BUDGET, SUBJECT);
  });

  yield* fs.makeDirectory(locksDir, { recursive: true }).pipe(
    Effect.matchEffect({
      onFailure: (error) => continueUnlocked(error.message),
      onSuccess: () =>
        holdLock(lockFile, NO_WAIT, SUBJECT).pipe(
          Effect.catchIf(isLockBusy, () => waitForHolder),
          Effect.matchEffect({
            onSuccess: () => record("acquired"),
            onFailure: (error) =>
              isLockBusy(error)
                ? record("busy").pipe(
                    Effect.andThen(
                      Effect.fail(
                        new LocalStackStartBusyError({
                          message: "another supabase start is still running for this project",
                          suggestion: `Wait for it to finish or cancel it, then run ${aqua("supabase start")} again.`,
                        }),
                      ),
                    ),
                  )
                : continueUnlocked(error.message),
          }),
        ),
    }),
  );
});
