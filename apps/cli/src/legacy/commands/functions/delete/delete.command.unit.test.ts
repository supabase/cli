import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { CurrentAnalyticsContext } from "../../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../../shared/telemetry/analytics.service.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { mockOutput, mockProcessControl } from "../../../../../tests/helpers/mocks.ts";
import { LEGACY_FUNCTIONS_DELETE_SAFE_FLAGS } from "./delete.command.ts";

function mockContextualAnalytics() {
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const layer = Layer.succeed(
    Analytics,
    Analytics.of({
      capture: (event: string, properties: Record<string, unknown> = {}) =>
        Effect.gen(function* () {
          const context = yield* CurrentAnalyticsContext;
          captured.push({ event, properties: { ...context, ...properties } });
        }),
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );
  return { layer, captured };
}

describe("legacy functions delete telemetry safe flags", () => {
  it("marks --project-ref as the only telemetry-safe flag (Go parity: cmd/functions.go:150-153)", () => {
    expect(LEGACY_FUNCTIONS_DELETE_SAFE_FLAGS).toEqual(["project-ref"]);
  });

  it.live("does not redact --project-ref in cli_command_executed, matching functions list", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { projectRef: Option.some("abcdefghijklmnopqrst") },
        safeFlags: LEGACY_FUNCTIONS_DELETE_SAFE_FLAGS,
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "delete",
            "hello-world",
            "--project-ref",
            "abcdefghijklmnopqrst",
          ]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["functions", "delete"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.event).toBe("cli_command_executed");
          expect(event?.properties.flags).toEqual({
            "project-ref": "abcdefghijklmnopqrst",
          });
        }),
      ),
    );
  });
});
