import {
  holdExclusiveLock,
  holdLock,
  holdSharedLock,
  isLockBusy,
  type NamespaceError,
} from "@supabase/stack/effect";
import { Clock, Crypto, Data, Duration, Effect, FileSystem, Path, type Scope } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { cliProjectFilterValue } from "./docker-ids.ts";

const LOCKS_DIR = "locks";
const GATE_FILE = "docker-lifecycle.lock";
const LOCK_BUDGET = Duration.minutes(10);
const LOCK_SUBJECT = "the Docker lifecycle lock";

/** Another lifecycle command kept the lock for the whole wait budget. */
export class ProjectLifecycleLockBusyError extends Data.TaggedError(
  "ProjectLifecycleLockBusyError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.invalidInput, fingerprint_suffix: "lease_held" };
  }
}

/** The lock files could not be created or opened. */
export class ProjectLifecycleLockIoError extends Data.TaggedError("ProjectLifecycleLockIoError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.runtimeCrash, fingerprint_suffix: "filesystem_io" };
  }
}

type LockError = ProjectLifecycleLockBusyError | ProjectLifecycleLockIoError;
type TakeLock = (
  file: string,
  budget: Duration.Input,
  subject: string,
) => Effect.Effect<void, NamespaceError, Scope.Scope>;

/**
 * Holds the cross-process lock that keeps lifecycle commands from pruning Docker resources another
 * command is still creating, for the enclosing scope. An empty `projectId` targets every project
 * (`stop --all`) and excludes all other holders; otherwise it excludes only commands for the same
 * project. Take it before any Docker probe and release it after rollback. It is not reentrant, so
 * never take it inside code a lock holder calls. Older binaries, raw `docker` commands, and a
 * different `SUPABASE_HOME` are not covered.
 */
export const holdProjectLifecycleLock = Effect.fn("ProjectLifecycleLock.hold")(function* (
  projectId: string,
) {
  const { supabaseHome } = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;
  const crypto = yield* Crypto.Crypto;

  const allProjects = projectId.length === 0;
  const started = yield* Clock.currentTimeMillis;
  let waited = false;

  const take = Effect.fnUntraced(function* (
    hold: TakeLock,
    file: string,
    waitingLine: string,
    busyMessage: string,
  ) {
    const failure = (error: NamespaceError): LockError =>
      isLockBusy(error)
        ? new ProjectLifecycleLockBusyError({ message: busyMessage })
        : new ProjectLifecycleLockIoError({ message: `failed to lock ${file}: ${error.message}` });
    yield* hold(file, Duration.zero, LOCK_SUBJECT).pipe(
      Effect.catchIf(isLockBusy, () =>
        Effect.gen(function* () {
          if (!waited) {
            waited = true;
            yield* output.raw(waitingLine, "stderr");
          }
          const elapsed = (yield* Clock.currentTimeMillis) - started;
          yield* hold(
            file,
            Duration.millis(Math.max(0, Duration.toMillis(LOCK_BUDGET) - elapsed)),
            LOCK_SUBJECT,
          );
        }),
      ),
      Effect.mapError(failure),
    );
  });

  yield* Effect.gen(function* () {
    const dir = path.join(supabaseHome, LOCKS_DIR);
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new ProjectLifecycleLockIoError({
            message: `failed to create ${dir}: ${error.message}`,
          }),
      ),
    );
    const gate = path.join(dir, GATE_FILE);

    if (allProjects) {
      yield* take(
        holdExclusiveLock,
        gate,
        "Waiting for another Supabase CLI command to finish with local Supabase projects...\n",
        "Another Supabase CLI command is still starting or stopping local Supabase projects. Wait for it to finish, then retry.",
      );
      return;
    }

    const digest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(cliProjectFilterValue(projectId)),
    );
    const key = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    yield* take(
      holdSharedLock,
      gate,
      "Waiting for another Supabase CLI command to finish with local Supabase projects...\n",
      "Another Supabase CLI command is stopping all local Supabase projects. Wait for it to finish, then retry.",
    );
    yield* take(
      holdLock,
      path.join(dir, `docker-project-${key}.lock`),
      `Waiting for another Supabase CLI command to finish with project ${projectId}...\n`,
      `Another Supabase CLI command is still starting or stopping project ${projectId}. Wait for it to finish, then retry.`,
    );
  }).pipe(
    Effect.tap(() => Effect.annotateCurrentSpan({ "lock.outcome": "acquired" })),
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({
        "lock.outcome": error._tag === "ProjectLifecycleLockBusyError" ? "timeout" : "error",
      }),
    ),
    Effect.onExit(() =>
      Effect.annotateCurrentSpan({
        "lock.mode": allProjects ? "all" : "project",
        "lock.waited": waited,
      }),
    ),
  );
});
