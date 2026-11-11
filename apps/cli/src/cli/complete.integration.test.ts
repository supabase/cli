import { BunCrypto } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { CurrentAnalyticsContext } from "../shared/telemetry/analytics-context.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { EventCommandExecuted, PropExitCode } from "../shared/telemetry/event-catalog.ts";
import { captureCompleteTelemetryEffect, tryComplete, type CompleteDeps } from "./complete.ts";
import { rootCommand } from "./root.ts";

// Mirrors the real `analyticsLayer`'s capture implementation just enough to merge
// `CurrentAnalyticsContext` into captured events, since the shared `mockAnalytics()` double
// doesn't read that context.
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
): CompleteDeps["captureTelemetry"] {
  return (exitCode, durationMs) =>
    captureCompleteTelemetryEffect(exitCode, durationMs).pipe(
      Effect.provide([analyticsLayer, BunCrypto.layer]),
      Effect.orDie,
    );
}

function makeDeps(argv: ReadonlyArray<string>, captureTelemetry: CompleteDeps["captureTelemetry"]) {
  const stdoutWrites: Array<string> = [];
  const exits: Array<number> = [];
  const deps: CompleteDeps = {
    root: rootCommand,
    argv,
    env: {},
    stdoutWrite: (message) => {
      stdoutWrites.push(message);
    },
    stderrWrite: () => {},
    exit: (code) => {
      exits.push(code);
    },
    captureTelemetry,
  };
  return { deps, stdoutWrites, exits };
}

describe("__complete telemetry (CLI-1965 review finding)", () => {
  it.effect(
    "fires cli_command_executed with command: __complete and exit_code: 0 for a normal completion request",
    () =>
      Effect.gen(function* () {
        const analytics = mockAnalyticsWithContext();
        const { deps } = makeDeps(
          ["__complete", "migration", "li"],
          makeCaptureTelemetry(analytics.layer),
        );

        expect(yield* tryComplete(deps)).toBe(true);

        const event = analytics.captured.find((entry) => entry.event === EventCommandExecuted);
        expect(event).toBeDefined();
        expect(event?.command).toBe("__complete");
        expect(event?.properties[PropExitCode]).toBe(0);
      }),
  );

  it.effect(
    "records exit_code: 1 for an unresolvable completion request (zero completion args)",
    () =>
      Effect.gen(function* () {
        const analytics = mockAnalyticsWithContext();
        const { deps } = makeDeps(["__complete"], makeCaptureTelemetry(analytics.layer));

        expect(yield* tryComplete(deps)).toBe(true);

        const event = analytics.captured.find((entry) => entry.event === EventCommandExecuted);
        expect(event).toBeDefined();
        expect(event?.properties[PropExitCode]).toBe(1);
      }),
  );

  it.effect(
    "records command: __complete — never __completeNoDesc — when invoked via the no-descriptions alias",
    () =>
      Effect.gen(function* () {
        const analytics = mockAnalyticsWithContext();
        const { deps } = makeDeps(
          ["__completeNoDesc", "migration", "li"],
          makeCaptureTelemetry(analytics.layer),
        );

        yield* tryComplete(deps);

        const event = analytics.captured.find((entry) => entry.event === EventCommandExecuted);
        expect(event?.command).toBe("__complete");
        expect(event?.command).not.toBe("__completeNoDesc");
      }),
  );
});
