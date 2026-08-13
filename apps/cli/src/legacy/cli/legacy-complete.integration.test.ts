import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { CurrentAnalyticsContext } from "../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { EventCommandExecuted, PropExitCode } from "../../shared/telemetry/event-catalog.ts";
import {
  legacyCaptureCompleteTelemetryEffect,
  legacyTryComplete,
  type LegacyCompleteDeps,
} from "./legacy-complete.ts";
import { legacyRoot } from "./root.ts";

// `mockAnalytics()` (`tests/helpers/mocks.ts`, the double `bash.integration.test.ts`
// uses for the same `cli_command_executed` assertion on the static completion
// leaves) records only the direct `capture(event, properties)` arguments — it
// never reads `CurrentAnalyticsContext`, so it can't see the `command` value
// `withAnalyticsContext` attaches. This local double mirrors the REAL
// `legacyAnalyticsLayer`'s own capture implementation just enough to merge
// that context in, so this file can assert on `command` the same way the
// review finding (CLI-1965) requires.
function mockAnalyticsWithContext() {
  const captured: Array<{
    event: string;
    properties: Record<string, unknown>;
    command: string | undefined;
  }> = [];
  return {
    layer: Layer.succeed(
      Analytics,
      Analytics.of({
        capture: (event, properties = {}) =>
          Effect.gen(function* () {
            const context = yield* CurrentAnalyticsContext;
            captured.push({ event, properties, command: context.command });
          }),
        identify: () => Effect.void,
        alias: () => Effect.void,
        groupIdentify: () => Effect.void,
      }),
    ),
    captured,
  };
}

function makeCaptureTelemetry(
  analyticsLayer: Layer.Layer<Analytics>,
): LegacyCompleteDeps["captureTelemetry"] {
  return (exitCode, durationMs) =>
    Effect.runPromise(
      legacyCaptureCompleteTelemetryEffect(exitCode, durationMs).pipe(
        Effect.provide(analyticsLayer),
      ),
    );
}

function makeDeps(
  argv: ReadonlyArray<string>,
  captureTelemetry: LegacyCompleteDeps["captureTelemetry"],
) {
  const stdoutWrites: Array<string> = [];
  const exits: Array<number> = [];
  const deps: LegacyCompleteDeps = {
    root: legacyRoot,
    argv,
    env: {},
    stdoutWrite: (message) => {
      stdoutWrites.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
    captureTelemetry,
  };
  return { deps, stdoutWrites, exits };
}

describe("legacy __complete telemetry (CLI-1965 review finding)", () => {
  it("fires cli_command_executed with command: __complete and exit_code: 0 for a normal completion request", async () => {
    const analytics = mockAnalyticsWithContext();
    const { deps } = makeDeps(
      ["__complete", "migration", "li"],
      makeCaptureTelemetry(analytics.layer),
    );

    expect(await legacyTryComplete(deps)).toBe(true);

    const event = analytics.captured.find((entry) => entry.event === EventCommandExecuted);
    expect(event).toBeDefined();
    expect(event?.command).toBe("__complete");
    expect(event?.properties[PropExitCode]).toBe(0);
  });

  it("records exit_code: 1 for an unresolvable completion request (zero completion args)", async () => {
    const analytics = mockAnalyticsWithContext();
    const { deps } = makeDeps(["__complete"], makeCaptureTelemetry(analytics.layer));

    expect(await legacyTryComplete(deps)).toBe(true);

    const event = analytics.captured.find((entry) => entry.event === EventCommandExecuted);
    expect(event).toBeDefined();
    expect(event?.properties[PropExitCode]).toBe(1);
  });

  it("records command: __complete — never __completeNoDesc — when invoked via the no-descriptions alias", async () => {
    const analytics = mockAnalyticsWithContext();
    const { deps } = makeDeps(
      ["__completeNoDesc", "migration", "li"],
      makeCaptureTelemetry(analytics.layer),
    );

    await legacyTryComplete(deps);

    const event = analytics.captured.find((entry) => entry.event === EventCommandExecuted);
    expect(event?.command).toBe("__complete");
    expect(event?.command).not.toBe("__completeNoDesc");
  });
});
