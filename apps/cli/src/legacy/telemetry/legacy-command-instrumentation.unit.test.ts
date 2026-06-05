import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { CurrentAnalyticsContext } from "../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { withLegacyCommandInstrumentation } from "./legacy-command-instrumentation.ts";

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

describe("withLegacyCommandInstrumentation", () => {
  it.live("annotates the command span and emits cli_command_executed", () => {
    const analytics = mockContextualAnalytics();

    return Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      expect(span.name).toBe("command.backups.list");
      expect(span.attributes.get("command")).toBe("backups list");
      expect(typeof span.attributes.get("command_run_id")).toBe("string");
    }).pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["backups", "list"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          const event = analytics.captured[0];
          expect(event?.event).toBe("cli_command_executed");
          expect(event?.properties.command).toBe("backups list");
          expect(event?.properties.exit_code).toBe(0);
          expect(typeof event?.properties.duration_ms).toBe("number");
        }),
      ),
    );
  });

  it.live("emits a single `flags` map (no `flags_used`/`flag_values`)", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { projectRef: Option.some("abcdefghijklmnopqrst") },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["secrets", "list", "--project-ref", "abcdefghijklmnopqrst"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["secrets", "list"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ "project-ref": "<redacted>" });
          expect(event?.properties).not.toHaveProperty("flags_used");
          expect(event?.properties).not.toHaveProperty("flag_values");
        }),
      ),
    );
  });

  it.live("redacts unsafe string flag values", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { envFile: Option.some("/path/to/.env") },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["secrets", "set", "--env-file=/path/to/.env"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["secrets", "set"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ "env-file": "<redacted>" });
        }),
      ),
    );
  });

  it.live("passes boolean flag values through verbatim", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: {
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "ssl-enforcement",
            "update",
            "--enable-db-ssl-enforcement",
            "--disable-db-ssl-enforcement",
          ]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["ssl-enforcement", "update"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({
            "disable-db-ssl-enforcement": false,
            "enable-db-ssl-enforcement": true,
          });
        }),
      ),
    );
  });

  it.live("passes safeFlags values through verbatim", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { projectRef: Option.some("abcdefghijklmnopqrst") },
        safeFlags: ["project-ref"],
      }),
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["link", "--project-ref", "abcdefghijklmnopqrst"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["link"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({
            "project-ref": "abcdefghijklmnopqrst",
          });
        }),
      ),
    );
  });

  it.live("omits the `flags` property when no flags changed", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({ flags: {} }),
      Effect.provide(analytics.layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["backups", "list"]) })),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toBeUndefined();
        }),
      ),
    );
  });

  it.live("captures failed commands with exit_code=1", () => {
    const analytics = mockContextualAnalytics();

    return withLegacyCommandInstrumentation()(Effect.fail(new Error("boom"))).pipe(
      Effect.provide(analytics.layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["backups", "list"]) })),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.exit,
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.properties.exit_code).toBe(1);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("skips analytics capture when analytics are disabled", () => {
    const analytics = mockContextualAnalytics();

    return Effect.sync(() => "ok").pipe(
      withLegacyCommandInstrumentation({ analytics: false }),
      Effect.provide(analytics.layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["telemetry", "enable"]) })),
      Effect.provide(commandRuntimeLayer(["telemetry", "enable"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toEqual([]);
        }),
      ),
    );
  });

  it.live("sorts flag names alphabetically to match Go", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: {
          projectRef: Option.some("abcdefghijklmnopqrst"),
          timestamp: Option.some(1707407047),
        },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "backups",
            "restore",
            "--timestamp=1707407047",
            "--project-ref",
            "abcdefghijklmnopqrst",
          ]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["backups", "restore"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          const flags = event?.properties.flags as Record<string, unknown>;
          // Keys should be insertion-ordered alphabetically.
          expect(Object.keys(flags)).toEqual(["project-ref", "timestamp"]);
        }),
      ),
    );
  });
});
