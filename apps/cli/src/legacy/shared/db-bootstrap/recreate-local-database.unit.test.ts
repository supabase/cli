import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";

import type { LegacyDbSession } from "../legacy-db-connection.service.ts";
import { LegacyDbExecError } from "../legacy-db-connection.errors.ts";
import { legacyResetDisconnectClients } from "./recreate-local-database.ts";

const COUNT_REPLICATION_SLOTS =
  "SELECT COUNT(*) FROM pg_replication_slots WHERE database IN ('postgres', '_supabase')";

/**
 * A minimal {@link LegacyDbSession} mock built entirely from `Effect.succeed`/
 * `Effect.suspend` — no real filesystem/Docker I/O anywhere in the chain, unlike
 * driving the full `legacyDbReset` composite effect through `TestClock`. That's
 * what makes the boundary tests below reliable: `legacyResetDisconnectClients`
 * reaches its retry schedule's sleep on the very first synchronous pass, so a
 * single `TestClock.adjust` per round always lands exactly where expected —
 * see `legacyResetDisconnectClients`'s own doc comment.
 */
function mockSession(opts: {
  readonly counts?: ReadonlyArray<number>;
  readonly queryFails?: boolean;
}) {
  const queries: Array<string> = [];
  let callIndex = 0;
  const session: LegacyDbSession = {
    exec: () => Effect.void,
    query: (sql): Effect.Effect<ReadonlyArray<Record<string, unknown>>, LegacyDbExecError> =>
      Effect.suspend(() => {
        queries.push(sql);
        if (sql !== COUNT_REPLICATION_SLOTS) return Effect.succeed([]);
        if (opts.queryFails === true) {
          return Effect.fail(new LegacyDbExecError({ message: "connection reset" }));
        }
        const counts = opts.counts ?? [0];
        const count = counts[Math.min(callIndex, counts.length - 1)] ?? 0;
        callIndex++;
        return Effect.succeed([{ count: String(count) }]);
      }),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return {
    session,
    get queries() {
      return queries;
    },
  };
}

describe("legacyResetDisconnectClients", () => {
  it.effect("resolves once replication slots drain within the retry budget", () =>
    Effect.gen(function* () {
      const mock = mockSession({ counts: [2, 1, 0] });
      const fiber = yield* legacyResetDisconnectClients(mock.session).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 seconds");
      yield* TestClock.adjust("1 seconds");
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(mock.queries.filter((sql) => sql === COUNT_REPLICATION_SLOTS)).toHaveLength(3);
    }),
  );

  it.effect(
    "is still retrying after 9 one-second backoffs, but fails once the 10th is exhausted — pins Go's `NewBackoffPolicy(ctx, 10*time.Second)` constant",
    () =>
      Effect.gen(function* () {
        // Never drains — pegs the retry schedule to its hard 10-retry ceiling.
        const mock = mockSession({ counts: [1] });
        const fiber = yield* legacyResetDisconnectClients(mock.session).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        for (let i = 0; i < 9; i++) {
          yield* TestClock.adjust("1 seconds");
        }
        // Not yet exhausted — 9 retries is one short of Go's hardcoded 10-retry cap.
        expect(fiber.pollUnsafe()).toBeUndefined();

        // The 10th one-second backoff crosses the boundary.
        yield* TestClock.adjust("1 seconds");
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(mock.queries.filter((sql) => sql === COUNT_REPLICATION_SLOTS)).toHaveLength(11);
      }),
  );

  it.effect(
    "fails permanently, without retrying, when counting replication slots itself fails",
    () =>
      Effect.gen(function* () {
        const mock = mockSession({ queryFails: true });
        const exit = yield* legacyResetDisconnectClients(mock.session).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        // A single attempt — the permanent (non-retryable) failure never retries.
        expect(mock.queries.filter((sql) => sql === COUNT_REPLICATION_SLOTS)).toHaveLength(1);
      }),
  );
});
