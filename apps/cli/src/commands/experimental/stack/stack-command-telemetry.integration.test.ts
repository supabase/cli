import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { Command } from "effect/unstable/cli";
import { StackIdSchema } from "@supabase/stack/effect";
import type { EffectStack, StackStatus } from "@supabase/stack/effect";
import { legacyExperimentalStackCommand } from "./stack.command.ts";
import {
  LegacyExperimentalStackApi,
  legacyExperimentalStackTargetResolverLayer,
} from "./stack.shared.ts";
import { legacyExperimentalStackStatusAliasCommand } from "../../../cli/root.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../tests/helpers/mocks.ts";
import { mockLegacyCliSettings } from "../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { LegacyYesFlag } from "../../../shared/legacy/global-flags.ts";
import { CurrentAnalyticsContext } from "../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import { OutputFormatFlag } from "../../../shared/cli/global-flags.ts";
import { LEGACY_GLOBAL_FLAGS } from "../../../shared/legacy/global-flags.ts";
import { processControlLayer } from "../../../shared/runtime/process-control.layer.ts";
import {
  EventCommandExecuted,
  PropCommand,
  PropCommandRunId,
} from "../../../shared/telemetry/event-catalog.ts";

const stackId = StackIdSchema.make("a".repeat(64));
const stackStatus: StackStatus = {
  id: stackId,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: [],
  artifacts: [],
};

function setup() {
  const output = mockOutput();
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const analytics = {
    captured,
    layer: Layer.succeed(
      Analytics,
      Analytics.of({
        capture: (event, properties = {}) =>
          Effect.gen(function* () {
            const context = yield* CurrentAnalyticsContext;
            captured.push({ event, properties: { ...context, ...properties } });
          }),
        identify: () => Effect.void,
        alias: () => Effect.void,
        groupIdentify: () => Effect.void,
      }),
    ),
  };
  const descriptor = {
    id: stackId,
    projectRoot: "/project",
    name: "default",
    branchContext: "ordinary-workspace",
    runtime: { kind: "native" as const },
    desiredLifecycle: "running" as const,
  };
  const stack = {
    id: stackId,
    status: () => Effect.succeed(stackStatus),
    credentials: () => Effect.die("unused"),
    prepare: () => Effect.die("unused"),
    start: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    destroy: () => Effect.die("unused"),
    logs: () => Effect.die("unused"),
    followLogs: () => Stream.empty,
  } satisfies EffectStack;
  const api = Layer.succeed(LegacyExperimentalStackApi, {
    createStack: () => Effect.die("unused"),
    listStacks: () => Effect.succeed([descriptor]),
    findStack: () => Effect.succeed(Option.some(descriptor)),
    openStack: () => Effect.succeed(stack),
    inspectStack: () => Effect.succeed({ descriptor, owner: "running" as const }),
  });
  return {
    output,
    analytics,
    layer: Layer.mergeAll(
      BunServices.layer,
      mockLegacyCliSettings({ workdir: "/project" }),
      processControlLayer,
      output.layer,
      analytics.layer,
      api,
      legacyExperimentalStackTargetResolverLayer,
      mockStdin(false),
      mockTty(),
      Layer.succeed(CliArgs, { args: [] }),
      Layer.succeed(LegacyYesFlag, false),
    ),
  };
}

const testRoot = (
  command: typeof legacyExperimentalStackCommand | typeof legacyExperimentalStackStatusAliasCommand,
) =>
  Command.make("supabase").pipe(
    Command.withGlobalFlags([OutputFormatFlag, ...LEGACY_GLOBAL_FLAGS]),
    Command.withSubcommands([command]),
  );

describe("stack command telemetry", () => {
  it.live("records canonical and alias command paths with distinct run ids", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      yield* Command.runWith(testRoot(legacyExperimentalStackCommand), { version: "0.0.0-test" })([
        "stack",
        "list",
      ]);
      yield* Command.runWith(testRoot(legacyExperimentalStackCommand), { version: "0.0.0-test" })([
        "stack",
        "list",
      ]);
      yield* Command.runWith(testRoot(legacyExperimentalStackStatusAliasCommand), {
        version: "0.0.0-test",
      })(["status"]);
      const events = fixture.analytics.captured.filter(
        (event) => event.event === EventCommandExecuted,
      );
      expect(events.map((event) => event.properties[PropCommand])).toEqual([
        "stack list",
        "stack list",
        "status",
      ]);
      const runIds = events.map((event) => event.properties[PropCommandRunId]);
      expect(runIds.every((runId) => typeof runId === "string")).toBe(true);
      expect(new Set(runIds).size).toBe(3);
    }).pipe(Effect.provide(fixture.layer));
  });
});
