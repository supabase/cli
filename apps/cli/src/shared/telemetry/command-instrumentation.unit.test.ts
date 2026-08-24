import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Data, Effect, Exit, Layer, Option, Schema, Stdio } from "effect";
import { commandRuntimeLayer as rawCommandRuntimeLayer } from "../runtime/command-runtime.layer.ts";
import { CurrentAnalyticsContext } from "./analytics-context.ts";
import { Analytics } from "./analytics.service.ts";
import { withCommandInstrumentation } from "./command-instrumentation.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "./error-actionability.ts";
import {
  PropErrorCategory,
  PropErrorFingerprint,
  PropErrorKind,
  PropHasSuggestion,
  PropSuggestedCommand,
  PropSuggestionType,
  PropWorkflow,
} from "./event-catalog.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";

const commandRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  rawCommandRuntimeLayer(commandPath).pipe(Layer.provide(BunServices.layer));

const FAILURE_PROPERTY_NAMES = [
  PropErrorKind,
  PropErrorCategory,
  PropErrorFingerprint,
  PropHasSuggestion,
  PropSuggestionType,
  PropSuggestedCommand,
  PropWorkflow,
] as const;

class InstrumentationAuthError extends Data.TaggedError("InstrumentationAuthError")<{
  readonly message: string;
  readonly path: string;
  readonly sql: string;
  readonly projectRef: string;
  readonly hostname: string;
  readonly token: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

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

function failingAnalytics(defect: unknown) {
  return Layer.succeed(
    Analytics,
    Analytics.of({
      capture: () => Effect.die(defect),
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );
}

function interruptingAnalytics() {
  return Layer.succeed(
    Analytics,
    Analytics.of({
      capture: () => Effect.interrupt,
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );
}

describe("withCommandInstrumentation", () => {
  it.live("creates a command span and annotates it with command metadata", () => {
    const analytics = mockContextualAnalytics();

    return Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      expect(span.name).toBe("command.branches.list");
      expect(span.attributes.get("command")).toBe("branches list");
      expect(typeof span.attributes.get("command_run_id")).toBe("string");
    }).pipe(
      withCommandInstrumentation({ analytics: false }),
      Effect.provide(
        Layer.mergeAll(
          analytics.layer,
          mockOutput({ format: "text" }).layer,
          Stdio.layerTest({
            args: Effect.succeed(["branches", "list"]),
          }),
          commandRuntimeLayer(["branches", "list"]),
        ),
      ),
    );
  });

  it.live("shares one command_run_id across milestone and command events", () => {
    const analytics = mockContextualAnalytics();

    return Effect.gen(function* () {
      const service = yield* Analytics;
      const context = yield* CurrentAnalyticsContext;

      yield* service.capture("cli_stack_started", {
        command_run_id: context.command_run_id,
      });
    }).pipe(
      withCommandInstrumentation(),
      Effect.provide(
        Layer.mergeAll(
          analytics.layer,
          mockOutput({ format: "text" }).layer,
          Stdio.layerTest({
            args: Effect.succeed(["start", "--detach", "--exclude=auth"]),
          }),
          commandRuntimeLayer(["start"]),
        ),
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
          for (const property of FAILURE_PROPERTY_NAMES) {
            expect(command?.properties).not.toHaveProperty(property);
          }
        }),
      ),
    );
  });

  it.live("adds sanitized actionability metadata and preserves the original failure", () => {
    const analytics = mockContextualAnalytics();
    const secrets = {
      message: "failed at /Users/alice/private/config.toml",
      path: "/Users/alice/private/config.toml",
      sql: "select * from customer_private_table",
      projectRef: "abcdefghijklmnopqrst",
      hostname: "db.customer.internal",
      token: "customer-secret-token",
    };
    const failure = new InstrumentationAuthError(secrets);

    const program = withCommandInstrumentation()(Effect.fail(failure)).pipe(
      Effect.provide(
        Layer.mergeAll(
          analytics.layer,
          mockOutput({ format: "text" }).layer,
          Stdio.layerTest({
            args: Effect.succeed(["login"]),
          }),
          commandRuntimeLayer(["login"]),
        ),
      ),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.gen(function* () {
          expect(analytics.captured).toHaveLength(1);
          const event = analytics.captured[0];
          const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
            event,
          );
          yield* Effect.sync(() => {
            expect(event?.event).toBe("cli_command_executed");
            expect(event?.properties).toMatchObject({
              exit_code: 1,
              error_kind: "user_actionable",
              error_category: "auth",
              error_fingerprint: "tag:InstrumentationAuthError",
              has_suggestion: true,
              suggestion_type: "login",
              suggested_command: "supabase login",
            });
            expect(event?.properties).not.toHaveProperty(PropWorkflow);
            for (const secret of Object.values(secrets)) expect(encoded).not.toContain(secret);

            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(failure);
            }
          });
        }),
      ),
    );

    return program.pipe(Effect.asVoid);
  });

  it.live("classifies defects as internal panics without capturing their message", () => {
    const analytics = mockContextualAnalytics();
    const secret = "panic at /Users/alice/customer-project";

    return Effect.die(new TypeError(secret)).pipe(
      withCommandInstrumentation(),
      Effect.provide(
        Layer.mergeAll(
          analytics.layer,
          mockOutput({ format: "text" }).layer,
          Stdio.layerTest({ args: Effect.succeed(["branches", "list"]) }),
          commandRuntimeLayer(["branches", "list"]),
        ),
      ),
      Effect.exit,
      Effect.tap(() =>
        Effect.gen(function* () {
          const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
            analytics.captured[0],
          );
          yield* Effect.sync(() => {
            expect(analytics.captured[0]?.properties).toMatchObject({
              exit_code: 1,
              error_kind: "internal_bug",
              error_category: "panic",
              error_fingerprint: "error:TypeError",
              has_suggestion: true,
              suggestion_type: "rerun_debug",
            });
            expect(encoded).not.toContain(secret);
          });
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("preserves the command failure when telemetry capture defects", () => {
    const failure = new InstrumentationAuthError({
      message: "command failure",
      path: "path",
      sql: "sql",
      projectRef: "project",
      hostname: "host",
      token: "token",
    });

    return Effect.fail(failure).pipe(
      withCommandInstrumentation(),
      Effect.provide(
        Layer.mergeAll(
          failingAnalytics(new Error("telemetry defect")),
          mockOutput({ format: "text" }).layer,
          Stdio.layerTest({ args: Effect.succeed(["login"]) }),
          commandRuntimeLayer(["login"]),
        ),
      ),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(failure);
            expect(Cause.hasDies(exit.cause)).toBe(false);
          }
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("propagates fiber interruption from telemetry capture", () => {
    // A capture failure or defect is swallowed (best-effort telemetry), but an
    // interruption landing during the trailing capture must not be — the fiber
    // is being cancelled and swallowing would fight the cancellation.
    return Effect.void.pipe(
      withCommandInstrumentation(),
      Effect.provide(
        Layer.mergeAll(
          interruptingAnalytics(),
          mockOutput({ format: "text" }).layer,
          Stdio.layerTest({ args: Effect.succeed(["login"]) }),
          commandRuntimeLayer(["login"]),
        ),
      ),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          }
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("captures flag values only when explicitly allowlisted", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withCommandInstrumentation({
        flags: {
          stack: "default",
          mode: "docker" as const,
          exclude: ["auth", "storage"],
          serviceVersion: [],
          detach: true,
        },
        allowedFlagValues: ["exclude", "mode", "stack"],
      }),
      Effect.provide(
        Layer.mergeAll(
          analytics.layer,
          mockOutput({ format: "text" }).layer,
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
          commandRuntimeLayer(["start"]),
        ),
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
      withCommandInstrumentation({
        flags: {
          token: Option.none<string>(),
          name: Option.some("my-machine"),
          noBrowser: true,
        },
        allowedFlagValues: ["token", "name", "noBrowser"],
      }),
      Effect.provide(
        Layer.mergeAll(
          analytics.layer,
          mockOutput({ format: "text" }).layer,
          Stdio.layerTest({
            args: Effect.succeed(["login", "--name", "my-machine", "--no-browser"]),
          }),
          commandRuntimeLayer(["login"]),
        ),
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

  it.live("skips analytics capture when analytics are disabled", () => {
    const analytics = mockContextualAnalytics();

    return Effect.succeed("ok").pipe(
      withCommandInstrumentation({ analytics: false }),
      Effect.provide(
        Layer.mergeAll(
          analytics.layer,
          mockOutput({ format: "text" }).layer,
          Stdio.layerTest({
            args: Effect.succeed(["telemetry", "enable"]),
          }),
          commandRuntimeLayer(["telemetry", "enable"]),
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toEqual([]);
        }),
      ),
    );
  });
});
