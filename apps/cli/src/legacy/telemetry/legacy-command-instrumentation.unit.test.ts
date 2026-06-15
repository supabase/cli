import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { CurrentAnalyticsContext } from "../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { withLegacyCommandInstrumentation } from "./legacy-command-instrumentation.ts";
import { mockOutput, mockProcessControl } from "../../../tests/helpers/mocks.ts";

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
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
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
          expect(event?.properties.output_format).toBe("text");
        }),
      ),
    );
  });

  it.live("reports legacy Go machine output formats emitted through the text layer", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["backups", "list", "--output", "yaml"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured[0]?.properties.output_format).toBe("yaml");
        }),
      ),
    );
  });

  it.live("keeps the TS output format when legacy --output pretty defers to it", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "json" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "backups",
            "list",
            "--output",
            "pretty",
            "--output-format",
            "json",
          ]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured[0]?.properties.output_format).toBe("json");
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
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
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
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
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

  it.live("records a flag set via its shorthand under the canonical name", () => {
    // Go's changedFlags() uses pflag Visit, which reports the canonical `schema`
    // name even when the user typed the `-s` shorthand (cmd/db.go:506). The alias
    // map lets the TS instrumentation match the single-dash form.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { schema: Option.some(["public"]) },
        aliases: { s: "schema" },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["db", "lint", "-s", "public"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "lint"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          // Slice flag stays redacted (not an EnumFlag/bool), but it IS recorded.
          expect(event?.properties.flags).toEqual({ schema: "<redacted>" });
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
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
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
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
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
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
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
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
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

  it.live("records exit_code=1 when a handler set a non-zero exit code without failing", () => {
    // Go records the telemetry exit code from the real process exit code
    // (`cmd/root.go:177` -> `exitCode(err)` = 1). `db lint`/`db advisors` set
    // ProcessControl's exit code in json/stream-json mode after a --fail-on
    // trigger and return success (to keep the machine payload on stdout intact),
    // so the instrumentation must report 1, not the Effect's success.
    const analytics = mockContextualAnalytics();
    const processControl = mockProcessControl();

    return Effect.gen(function* () {
      const pc = yield* ProcessControl;
      yield* pc.setExitCode(1);
    }).pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(processControl.layer),
      Effect.provide(mockOutput({ format: "json" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["db", "lint"]) })),
      Effect.provide(commandRuntimeLayer(["db", "lint"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.properties.exit_code).toBe(1);
        }),
      ),
    );
  });

  it.live("skips analytics capture when analytics are disabled", () => {
    const analytics = mockContextualAnalytics();

    return Effect.sync(() => "ok").pipe(
      withLegacyCommandInstrumentation({ analytics: false }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
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
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
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
