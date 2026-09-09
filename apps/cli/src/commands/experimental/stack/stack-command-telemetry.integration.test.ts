import { BunServices } from "@effect/platform-bun";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- temporary project fixture
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- temporary project fixture
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { CliOutput, Command } from "effect/unstable/cli";
import { Effect, Layer, Option } from "effect";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  processEnvLayer,
} from "../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DebugFlag, ProfileFlag, WorkdirFlag } from "../../../command-internal/global-flags.ts";
import {
  EventCommandExecuted,
  PropCommand,
  PropCommandRunId,
} from "../../../shared/telemetry/event-catalog.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { stackCommand } from "../../../commands/experimental/stack/stack.command.ts";
import { stackStopAliasCommand } from "../../../cli/root.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "supabase-stack-telemetry-"));
  mkdirSync(join(root, "supabase"));
  const output = mockOutput();
  const analytics = mockContextualAnalytics();
  const processControl = mockProcessControl();
  return {
    analytics,
    output,
    layer: Layer.mergeAll(
      BunServices.layer,
      CliOutput.layer(textCliOutputFormatter()),
      output.layer,
      analytics.layer,
      processControl.layer,
      Layer.succeed(CliArgs, { args: [] }),
      Layer.succeed(DebugFlag, false),
      Layer.succeed(ProfileFlag, "supabase"),
      Layer.succeed(WorkdirFlag, Option.none()),
      mockRuntimeInfo({ cwd: root, homeDir: root }),
      mockTelemetryRuntime({
        configDir: join(root, ".supabase"),
        tracesDir: join(root, ".supabase", "traces"),
      }),
      processEnvLayer({ SUPABASE_HOME: join(root, ".supabase") }),
    ),
    root,
  };
}

describe("stack command telemetry", () => {
  it.live("records canonical and top-level stop paths with distinct run ids", () => {
    const fixture = setup();
    const canonical = stackCommand.pipe(Command.provide(fixture.layer));
    const alias = stackStopAliasCommand.pipe(Command.provide(fixture.layer));
    return Effect.gen(function* () {
      yield* Command.runWith(canonical, { version: "0.0.0-test" })(["stop"]);
      yield* Command.runWith(alias, { version: "0.0.0-test" })([]);
      const events = fixture.analytics.captured.filter(
        (event) => event.event === EventCommandExecuted,
      );
      expect(events.map((event) => event.properties[PropCommand])).toEqual(["stack stop", "stop"]);
      const runIds = events.map((event) => event.properties[PropCommandRunId]);
      expect(runIds.every((runId) => typeof runId === "string")).toBe(true);
      expect(new Set(runIds).size).toBe(2);
      expect(fixture.output.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "success", data: { found: false } }),
        ]),
      );
    }).pipe(
      Effect.provide(fixture.layer),
      Effect.ensuring(Effect.sync(() => rmSync(fixture.root, { recursive: true, force: true }))),
    );
  });
});
