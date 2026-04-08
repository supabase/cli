import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { CurrentAnalyticsContext, withAnalyticsContext } from "./analytics-context.ts";

describe("withAnalyticsContext", () => {
  it.live("merges context lexically and restores the previous value afterward", () =>
    Effect.gen(function* () {
      const before = yield* CurrentAnalyticsContext;
      expect(before).toEqual({});

      const nested = yield* Effect.gen(function* () {
        const current = yield* CurrentAnalyticsContext;
        return current;
      }).pipe(
        withAnalyticsContext({
          command_run_id: "run-123",
          groups: {
            organization: "supabase",
          },
        }),
        withAnalyticsContext({
          command: "login",
          groups: {
            project: "project-ref",
          },
        }),
      );

      expect(nested).toEqual({
        command_run_id: "run-123",
        command: "login",
        groups: {
          organization: "supabase",
          project: "project-ref",
        },
      });

      const after = yield* CurrentAnalyticsContext;
      expect(after).toEqual({});
    }),
  );

  it.live("is inherited by child fibers", () =>
    Effect.gen(function* () {
      const child = yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            return yield* CurrentAnalyticsContext;
          }),
        );
        return yield* Fiber.join(fiber);
      }).pipe(
        withAnalyticsContext({
          command_run_id: "run-456",
          command: "start",
        }),
      );

      expect(child).toEqual({
        command_run_id: "run-456",
        command: "start",
      });
    }),
  );
});
