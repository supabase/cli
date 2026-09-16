import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliOutput, Command } from "effect/unstable/cli";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockStdin,
  mockTty,
  processEnvLayer,
} from "../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  ExperimentalFlag,
  ProfileFlag,
  WorkdirFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import {
  EventCommandExecuted,
  PropCommand,
  PropCommandRunId,
} from "../../../shared/telemetry/event-catalog.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { stackCommand } from "./stack.command.ts";
import { stackStopAliasCommand } from "../../../cli/root.ts";

const setup = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-telemetry-" });
    yield* fs.makeDirectory(path.join(root, "supabase"));
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
        Layer.succeed(ExperimentalFlag, false),
        Layer.succeed(ProfileFlag, "supabase"),
        Layer.succeed(WorkdirFlag, Option.none()),
        Layer.succeed(YesFlag, false),
        mockTty({ stdinIsTty: false, stdoutIsTty: false }),
        mockStdin(false),
        mockRuntimeInfo({ cwd: root, homeDir: root }),
        mockTelemetryRuntime({
          configDir: path.join(root, ".supabase"),
          tracesDir: path.join(root, ".supabase", "traces"),
        }),
        processEnvLayer({ SUPABASE_HOME: path.join(root, ".supabase") }),
      ),
    };
  });

describe("stack command telemetry", () => {
  it.live("records the canonical list command identity", () => {
    return setup().pipe(
      Effect.flatMap((fixture) => {
        const command = stackCommand.pipe(Command.provide(fixture.layer));
        return Effect.gen(function* () {
          yield* Command.runWith(command, { version: "0.0.0-test" })(["list"]);
          const event = fixture.analytics.captured.find(
            (candidate) => candidate.event === EventCommandExecuted,
          );
          expect(
            fixture.analytics.captured.filter(
              (candidate) => candidate.event === EventCommandExecuted,
            ),
          ).toHaveLength(1);
          expect(event?.properties[PropCommand]).toBe("stack list");
          expect(event?.properties[PropCommandRunId]).toEqual(expect.any(String));
        }).pipe(Effect.provide(fixture.layer));
      }),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("records canonical and top-level stop paths with distinct run ids", () => {
    return setup().pipe(
      Effect.flatMap((fixture) => {
        const canonical = stackCommand.pipe(Command.provide(fixture.layer));
        const alias = stackStopAliasCommand.pipe(Command.provide(fixture.layer));
        return Effect.gen(function* () {
          yield* Command.runWith(canonical, { version: "0.0.0-test" })(["stop"]);
          yield* Command.runWith(alias, { version: "0.0.0-test" })([]);
          const events = fixture.analytics.captured.filter(
            (event) => event.event === EventCommandExecuted,
          );
          expect(events.map((event) => event.properties[PropCommand])).toEqual([
            "stack stop",
            "stop",
          ]);
          const runIds = events.map((event) => event.properties[PropCommandRunId]);
          expect(runIds.every((runId) => typeof runId === "string")).toBe(true);
          expect(new Set(runIds).size).toBe(2);
          expect(fixture.output.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "success", data: { found: false } }),
            ]),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("records the destroy command identity on invalid target input", () => {
    return setup().pipe(
      Effect.flatMap((fixture) => {
        const command = stackCommand.pipe(Command.provide(fixture.layer));
        return Effect.gen(function* () {
          yield* Command.runWith(command, { version: "0.0.0-test" })([
            "destroy",
            "--stack-id",
            "invalid",
          ]).pipe(Effect.flip);
          const event = fixture.analytics.captured.find(
            (candidate) => candidate.event === EventCommandExecuted,
          );
          expect(event?.properties[PropCommand]).toBe("stack destroy");
        }).pipe(Effect.provide(fixture.layer));
      }),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("records the prepare command identity on invalid target input", () => {
    return setup().pipe(
      Effect.flatMap((fixture) => {
        const command = stackCommand.pipe(Command.provide(fixture.layer));
        return Effect.gen(function* () {
          yield* Command.runWith(command, { version: "0.0.0-test" })([
            "prepare",
            "--stack-id",
            "invalid",
          ]).pipe(Effect.flip);
          const event = fixture.analytics.captured.find(
            (candidate) => candidate.event === EventCommandExecuted,
          );
          expect(event?.properties[PropCommand]).toBe("stack prepare");
        }).pipe(Effect.provide(fixture.layer));
      }),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("records the logs command identity when no stack exists", () => {
    return setup().pipe(
      Effect.flatMap((fixture) => {
        const command = stackCommand.pipe(Command.provide(fixture.layer));
        return Effect.gen(function* () {
          yield* Command.runWith(command, { version: "0.0.0-test" })(["logs"]);
          const event = fixture.analytics.captured.find(
            (candidate) => candidate.event === EventCommandExecuted,
          );
          expect(event?.properties[PropCommand]).toBe("stack logs");
          expect(fixture.output.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "success", data: { found: false, entries: [] } }),
            ]),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("records the restart command identity on invalid target input", () => {
    return setup().pipe(
      Effect.flatMap((fixture) => {
        const command = stackCommand.pipe(Command.provide(fixture.layer));
        return Effect.gen(function* () {
          yield* Command.runWith(command, { version: "0.0.0-test" })([
            "restart",
            "--stack-id",
            "invalid",
          ]).pipe(Effect.flip);
          const event = fixture.analytics.captured.find(
            (candidate) => candidate.event === EventCommandExecuted,
          );
          expect(event?.properties[PropCommand]).toBe("stack restart");
        }).pipe(Effect.provide(fixture.layer));
      }),
      Effect.provide(BunServices.layer),
    );
  });
});
