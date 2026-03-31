import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";
import { CurrentAnalyticsContext } from "./analytics-context.ts";
import { Analytics } from "./analytics.service.ts";
import { withCommandAnalytics } from "./command-analytics.ts";

function mockContextualAnalytics() {
  const captured: Array<{
    event: string;
    properties: Record<string, unknown>;
  }> = [];

  const layer = Layer.succeed(
    Analytics,
    Analytics.of({
      capture: (event: string, properties: Record<string, unknown> = {}) =>
        Effect.gen(function* () {
          const context = yield* CurrentAnalyticsContext;
          captured.push({
            event,
            properties: {
              ...context,
              ...properties,
            },
          });
        }),
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );

  return { layer, captured };
}

describe("withCommandAnalytics", () => {
  it.live("shares one command_run_id across milestone and command events", () => {
    const analytics = mockContextualAnalytics();

    return Effect.gen(function* () {
      const service = yield* Analytics;
      const context = yield* CurrentAnalyticsContext;

      yield* service.capture("cli_stack_started", {
        command_run_id: context.command_run_id,
      });
    }).pipe(
      withCommandAnalytics({ command: "start" }),
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["start", "--detach", "--exclude=auth"]),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(2);

          const milestone = analytics.captured[0];
          const command = analytics.captured[1];
          expect(milestone?.event).toBe("cli_stack_started");
          expect(command?.event).toBe("cli_command_executed");

          expect(typeof milestone?.properties.command_run_id).toBe("string");
          expect(milestone?.properties.command_run_id).toBe(command?.properties.command_run_id);
          expect(command?.properties.command).toBe("start");
          expect(command?.properties.flags_used).toEqual(["detach", "exclude"]);
          expect(command?.properties.flag_values).toEqual({});
          expect(command?.properties.exit_code).toBe(0);
        }),
      ),
    );
  });

  it.live("captures failed commands with a non-zero exit code", () => {
    const analytics = mockContextualAnalytics();

    const program = withCommandAnalytics({
      command: "login",
    })(Effect.fail(new Error("boom"))).pipe(
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["login"]),
        }),
      ),
      Effect.exit,
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.event).toBe("cli_command_executed");
          expect(analytics.captured[0]?.properties.exit_code).toBe(1);
        }),
      ),
    );

    return program.pipe(Effect.asVoid);
  });

  it.live("captures flag values only when explicitly allowlisted", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withCommandAnalytics({
        command: "start",
        flags: {
          stack: "default",
          mode: "docker" as const,
          exclude: ["auth", "storage"],
          serviceVersion: [],
          detach: true,
        },
        allowedFlagValues: ["exclude", "mode", "stack"],
      }),
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "start",
            "--detach",
            "--mode=docker",
            "--exclude",
            "auth",
            "--exclude",
            "storage",
          ]),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.properties.flags_used).toEqual([
            "detach",
            "exclude",
            "mode",
          ]);
          expect(analytics.captured[0]?.properties.flag_values).toEqual({
            exclude: ["auth", "storage"],
            mode: "docker",
          });
        }),
      ),
    );
  });

  it.live("unwraps Option values and emits kebab-case allowlisted keys only when used", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withCommandAnalytics({
        command: "login",
        flags: {
          token: Option.none<string>(),
          name: Option.some("my-machine"),
          noBrowser: true,
        },
        allowedFlagValues: ["token", "name", "noBrowser"],
      }),
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["login", "--name", "my-machine", "--no-browser"]),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.properties.flags_used).toEqual(["name", "no-browser"]);
          expect(analytics.captured[0]?.properties.flag_values).toEqual({
            name: "my-machine",
            "no-browser": true,
          });
        }),
      ),
    );
  });
});
