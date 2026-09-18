import { V1GetNetworkRestrictionsOutput } from "@supabase/api/effect";
import { Cause, Data, Effect, Exit, Schedule, Schema } from "effect";
import { expect } from "vitest";

import {
  experimentalProjectLiveFlags,
  type LiveFixtures,
  requireLiveJson,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

type LiveCliEffect = LiveFixtures["cliEffect"];
type LiveRun = Awaited<ReturnType<LiveFixtures["cli"]>>;

// The worst case across four 60s commands (restore issued at most twice) and two 102s proof
// polls is 444s, plus the workspace fixture's ~60s init — all bounded by the 20-minute Live
// E2E step budget shared by every serial live file. A timed-out test disposes its fixtures,
// so a late restore can't run and the shared project stays locked down.
const EXIT_TIMEOUT_MS = 60_000;
const POLL_ATTEMPT_EXIT_TIMEOUT_MS = 20_000;
const PROOF_TIMEOUT_MS = 60_000;
const PROOF_INTERVAL_MS = 2_000;
const LIVE_TIMEOUT_MS = 600_000;

interface AllowedCidrs {
  readonly v4: ReadonlyArray<string>;
  readonly v6: ReadonlyArray<string>;
}

// Documentation ranges (RFC 5737 TEST-NET-3, RFC 3849): public, so the local
// private-range check accepts them, and unroutable, so allowing them admits
// nobody while the project is restricted.
const TEST_CIDRS: AllowedCidrs = { v4: ["203.0.113.0/24"], v6: ["2001:db8::/32"] };

// The allow-all sentinels `config.toml` ships as the `db.network_restrictions`
// defaults; ADR 0022 treats them as the platform's unconfigured state.
const ALLOW_ALL_CIDRS: AllowedCidrs = { v4: ["0.0.0.0/0"], v6: ["::/0"] };

interface Posture {
  readonly cidrs: AllowedCidrs;
  readonly configured: boolean;
  readonly applied: boolean;
}

/** Typed proof failures keep the poll retrying transient exits and unpropagated reads alike. */
class LivePostureError extends Data.TaggedError("LivePostureError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const postureFailure = (error: unknown): LivePostureError =>
  new LivePostureError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });

function updateArgs(cidrs: AllowedCidrs, flags: ReadonlyArray<string>): string[] {
  return [
    "network-restrictions",
    "update",
    ...[...cidrs.v4, ...cidrs.v6].flatMap((cidr) => ["--db-allow-cidr", cidr]),
    ...flags,
  ];
}

function describeAttempt(attempt: number, result: LiveRun): string {
  return `\nattempt ${attempt} (exit ${result.exitCode})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

// An absent family reads as `[]` like an explicitly empty one; `configured`
// records whether any family key was present, which is what separates a
// never-configured project from one explicitly locked down to block-all.
function readPosture(
  cliEffect: LiveCliEffect,
  flags: ReadonlyArray<string>,
  label: string,
  exitTimeoutMs: number,
): Effect.Effect<Posture, LivePostureError> {
  return Effect.gen(function* () {
    const result = yield* cliEffect(["network-restrictions", "get", ...flags, "-o", "json"], {
      exitTimeoutMs,
    }).pipe(Effect.mapError(postureFailure));
    const payload = yield* Effect.try({
      try: () => {
        requireLiveSuccess(result, label);
        return requireLiveJson(result, label);
      },
      catch: postureFailure,
    });
    if (!Schema.is(V1GetNetworkRestrictionsOutput)(payload)) {
      return yield* new LivePostureError({
        message: `${label}: unexpected network-restrictions get payload\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      });
    }
    const v4 = payload.config.dbAllowedCidrs;
    const v6 = payload.config.dbAllowedCidrsV6;
    return {
      cidrs: { v4: v4 ?? [], v6: v6 ?? [] },
      configured: v4 !== undefined || v6 !== undefined,
      applied: payload.status === "applied",
    };
  });
}

function sortedCidrs(cidrs: AllowedCidrs): AllowedCidrs {
  return { v4: [...cidrs.v4].sort(), v6: [...cidrs.v6].sort() };
}

// get reports `status: "stored"` until the allowlist propagates, and the platform
// exposes no signal to wait on, so proving an update means polling get (bounded).
function expectApplied(
  cliEffect: LiveCliEffect,
  flags: ReadonlyArray<string>,
  cidrs: AllowedCidrs,
  label: string,
): Effect.Effect<void, LivePostureError> {
  const expected = { cidrs: sortedCidrs(cidrs), applied: true };
  return readPosture(cliEffect, flags, label, POLL_ATTEMPT_EXIT_TIMEOUT_MS).pipe(
    Effect.flatMap((posture) =>
      Effect.try({
        try: () =>
          expect({ cidrs: sortedCidrs(posture.cidrs), applied: posture.applied }, label).toEqual(
            expected,
          ),
        catch: postureFailure,
      }),
    ),
    Effect.retry(
      Schedule.spaced(PROOF_INTERVAL_MS).pipe(Schedule.upTo({ duration: PROOF_TIMEOUT_MS })),
    ),
  );
}

test(
  "replaces the allowlist, get proves it, and restores the baseline allowlist",
  { timeout: LIVE_TIMEOUT_MS },
  // Not wired to the test `signal`: an interrupt SIGKILLs an in-flight restore
  // mid-request (the run's scope release kills the process group), so letting the
  // bounded restore run out is strictly safer.
  ({ cliEffect, project }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const flags = experimentalProjectLiveFlags(project);
        const captured = yield* readPosture(
          cliEffect,
          flags,
          "network-restrictions get capture for network-restrictions update",
          EXIT_TIMEOUT_MS,
        );
        // A never-configured project has nothing to restore: fall back to allow-all so
        // later tests aren't locked out; a configured capture is restored as read.
        const baselineCidrs: AllowedCidrs = captured.configured ? captured.cidrs : ALLOW_ALL_CIDRS;
        const cleanupErrors: Array<unknown> = [];

        const target = Effect.gen(function* () {
          const updated = yield* cliEffect([...updateArgs(TEST_CIDRS, flags), "-o", "json"], {
            exitTimeoutMs: EXIT_TIMEOUT_MS,
          });
          expect(updated.exitCode, updated.stderr).toBe(0);
          expect(
            requireLiveJson(updated, "network-restrictions update"),
            updated.stdout,
          ).toMatchObject({
            config: { dbAllowedCidrs: TEST_CIDRS.v4, dbAllowedCidrsV6: TEST_CIDRS.v6 },
          });

          yield* expectApplied(
            cliEffect,
            flags,
            TEST_CIDRS,
            "network-restrictions get proof for network-restrictions update",
          );
        });

        const cleanup = Effect.gen(function* () {
          // One re-issue covers a transient failure; the proof alone decides success,
          // since a killed restore can exit non-zero after the platform applied it.
          const restore = () =>
            cliEffect(updateArgs(baselineCidrs, flags), { exitTimeoutMs: EXIT_TIMEOUT_MS });
          const first = yield* restore();
          if (first.exitCode !== 0) {
            yield* Effect.logWarning(
              "network-restrictions update restore retrying" + describeAttempt(1, first),
            );
          }
          const restored = first.exitCode === 0 ? first : yield* restore();
          if (restored.exitCode !== 0) {
            cleanupErrors.push(
              new Error(
                "network-restrictions update restore of the baseline allowlist failed twice" +
                  describeAttempt(1, first) +
                  describeAttempt(2, restored),
              ),
            );
          }
          yield* expectApplied(
            cliEffect,
            flags,
            baselineCidrs,
            "network-restrictions get proof of the restored allowlist for network-restrictions update",
          );
        });

        const targetExit = yield* Effect.exit(target);
        const cleanupExit = yield* Effect.exit(cleanup);
        if (Exit.isFailure(cleanupExit)) cleanupErrors.push(Cause.squash(cleanupExit.cause));
        return {
          targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
          cleanupErrors,
        };
      }),
    ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)),
);
