import { BunServices } from "@effect/platform-bun";
import { Cause, Data, Effect, Exit, FileSystem, Path, Schedule, Schema } from "effect";
import { expect } from "vitest";

import {
  type LiveFixtures,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

type LiveCliEffect = LiveFixtures["cliEffect"];

// Two polled proofs push the worst case past the live testTimeout.
const PUSH_EXIT_TIMEOUT_MS = 75_000;
const DIFF_EXIT_TIMEOUT_MS = 20_000;
const LIVE_TIMEOUT_MS = 600_000;
const PROOF_INTERVAL_MS = 2_000;
const PROOF_TIMEOUT_MS = 60_000;

/** Typed proof failures keep the poll retrying transient exits and unpropagated reads alike. */
class LiveConfigPushError extends Data.TaggedError("LiveConfigPushError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const liveFailure = (error: unknown): LiveConfigPushError =>
  new LiveConfigPushError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });

const DiffPayload = Schema.fromJsonString(
  Schema.Struct({
    changes: Schema.Array(
      Schema.Struct({ path: Schema.Array(Schema.String), remote: Schema.optional(Schema.Unknown) }),
    ),
  }),
);

const PushPayload = Schema.fromJsonString(
  Schema.Struct({
    project_ref: Schema.optional(Schema.Unknown),
    message: Schema.optional(Schema.Unknown),
    services: Schema.optional(
      Schema.Array(
        Schema.Struct({
          service: Schema.optional(Schema.Unknown),
          status: Schema.optional(Schema.Unknown),
          changes: Schema.optional(Schema.Unknown),
        }),
      ),
    ),
  }),
);

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function diffMaxRows(cliEffect: LiveCliEffect, ref: string, label: string) {
  return Effect.gen(function* () {
    const result = yield* cliEffect(
      ["config", "diff", "--project-ref", ref, "--output-format", "json"],
      { exitTimeoutMs: DIFF_EXIT_TIMEOUT_MS },
    ).pipe(Effect.mapError(liveFailure));
    yield* Effect.try({ try: () => requireLiveSuccess(result, label), catch: liveFailure });
    const { changes } = yield* Schema.decodeEffect(DiffPayload)(result.stdout).pipe(
      Effect.mapError(
        (error) =>
          new LiveConfigPushError({
            message: `${label}: unexpected config diff payload (${String(error)})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
            cause: error,
          }),
      ),
    );
    return changes.filter((change) => change.path.join(".") === "api.max_rows");
  });
}

// A diff right after a push can read the previous value, so proofs poll until it converges.
function expectMaxRowsConverged(cliEffect: LiveCliEffect, ref: string, label: string) {
  return diffMaxRows(cliEffect, ref, label).pipe(
    Effect.flatMap((entries) =>
      Effect.try({ try: () => expect(entries, label).toEqual([]), catch: liveFailure }),
    ),
    Effect.retry(
      Schedule.spaced(PROOF_INTERVAL_MS).pipe(Schedule.upTo({ duration: PROOF_TIMEOUT_MS })),
    ),
  );
}

// Golden path only: a sparse config.toml declaring one property round-trips through push,
// `config diff` proves convergence, and the restore push is re-proven the same way, since push
// exits 0 on "Nothing to push" too. Branch coverage lives in push.integration.test.ts.
test(
  "pushes one declared property, diff proves it landed, and a restore push puts the captured value back",
  { timeout: LIVE_TIMEOUT_MS },
  ({ cliEffect, project, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const writeConfig = (maxRows: number) =>
          fs.writeFileString(
            path.join(workspace.path, "supabase", "config.toml"),
            `project_id = "cli-live-config-push"\n\n[api]\nmax_rows = ${maxRows}\n`,
          );
        const pushArgs = [
          "config",
          "push",
          "--project-ref",
          project.ref,
          "--yes",
          "--output-format",
          "json",
        ];

        // No diff entry means the remote already reads the probe value.
        yield* writeConfig(777);
        const capturedEntry = (yield* diffMaxRows(
          cliEffect,
          project.ref,
          "config diff capture",
        ))[0];
        const captured = capturedEntry === undefined ? 777 : capturedEntry.remote;
        // A non-positive value is dropped from the local projection, which would
        // make the restore push a silent no-op — abort before any mutation.
        if (typeof captured !== "number" || !Number.isSafeInteger(captured) || captured <= 0) {
          return yield* new LiveConfigPushError({
            message: `unexpected api.max_rows capture: ${yield* jsonText(capturedEntry)}`,
          });
        }
        const changed = captured === 777 ? 778 : 777;

        const target = Effect.gen(function* () {
          yield* writeConfig(changed);
          const pushed = yield* cliEffect(pushArgs, { exitTimeoutMs: PUSH_EXIT_TIMEOUT_MS });
          requireLiveSuccess(pushed, "config push");
          const payload = yield* Schema.decodeEffect(PushPayload)(pushed.stdout);
          expect(payload, pushed.stdout).toEqual(
            expect.objectContaining({ project_ref: project.ref }),
          );
          expect(
            (payload.services ?? []).filter((service) => service.status === "updated"),
            pushed.stdout,
          ).toEqual([expect.objectContaining({ service: "api", changes: [["api", "max_rows"]] })]);
          expect(payload.message, pushed.stdout).toContain(`1 property pushed to ${project.ref}.`);

          yield* expectMaxRowsConverged(cliEffect, project.ref, "config diff proof");
        });

        const cleanup = Effect.gen(function* () {
          yield* writeConfig(captured);
          const restored = yield* cliEffect(pushArgs, { exitTimeoutMs: PUSH_EXIT_TIMEOUT_MS });
          requireLiveSuccess(restored, "config push restore of the captured value");
          yield* expectMaxRowsConverged(
            cliEffect,
            project.ref,
            "config diff proof of the restored value",
          );
        });

        const targetExit = yield* Effect.exit(target);
        const cleanupExit = yield* Effect.exit(cleanup);
        return {
          targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
          cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
        };
      }).pipe(Effect.provide(BunServices.layer)),
    ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)),
);
