import { describe, expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Exit } from "effect";
import { runSupabaseEffect } from "../../../tests/helpers/cli.ts";

class BlackholeServerError extends Data.TaggedError("BlackholeServerError")<{
  readonly cause: unknown;
}> {}

// A blackholed endpoint: accepts requests and never responds while the CLI runs, so telemetry
// requests hang until aborted. Asserts on the spawned process's wall-clock exit, since pending
// sockets keep the runtime alive and only actual process exit proves the telemetry exit cap holds
// end to end.
describe("telemetry against a blackholed PostHog endpoint", () => {
  it.live("commands exit promptly, cleanly, and quietly", () =>
    Effect.gen(function* () {
      const requestArrived = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const server = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch() {
                Deferred.doneUnsafe(requestArrived, Exit.void);
                return runPromise(
                  Deferred.await(released).pipe(Effect.as(new Response(null, { status: 204 }))),
                );
              },
            }),
          catch: (cause) => new BlackholeServerError({ cause }),
        }),
        (running) =>
          Deferred.succeed(released, undefined).pipe(
            Effect.andThen(Effect.promise(() => running.stop(true))),
          ),
      );

      const startedAt = performance.now();
      const { stdout, stderr, exitCode } = yield* runSupabaseEffect(["telemetry", "status"], {
        env: {
          // spawnSupabase disables telemetry for every test by default; this
          // test exists to exercise it, so turn it back on explicitly.
          SUPABASE_TELEMETRY_DISABLED: "0",
          DO_NOT_TRACK: "0",
          SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_e2e_blackhole_test",
          SUPABASE_TELEMETRY_POSTHOG_HOST: server.url.origin,
        },
      });
      const elapsedMs = performance.now() - startedAt;

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Telemetry is enabled.");
      expect(stderr).toBe("");
      expect(yield* Deferred.isDone(requestArrived)).toBe(true);
      // Healthy runs land near 2.5s (2s drain cap + spawn overhead); the nearest real failure
      // signature is the SDK's 5s default deadline plus startup.
      expect(elapsedMs).toBeLessThan(4_500);
    }),
  );
});
