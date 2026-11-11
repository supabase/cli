import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Stdio } from "effect";
import { Command } from "effect/cli";
import { computeLogsCommand } from "../experimental/compute/logs/logs.command.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockCommandPlatformApi,
  buildTestRuntime,
} from "../../../tests/helpers/command-mocks.ts";

it.live("preserves bounded legacy compute defaults through the parser", () =>
  Effect.gen(function* () {
    const workdir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "logs-compat-parser-",
    });
    let reached = false;
    const command = computeLogsCommand.pipe(
      Command.withHandler((flags) =>
        Effect.sync(() => {
          reached = true;
          expect(flags).toMatchObject({ name: "api", tail: 100, follow: false });
          expect(Option.isNone(flags.kind)).toBe(true);
        }),
      ),
    );
    const args = ["logs", "api"];
    const root = Command.make("supabase").pipe(Command.withSubcommands([command]));
    yield* Command.runWith(root, { version: "test" })(args).pipe(
      Effect.provide(
        Layer.mergeAll(
          buildTestRuntime({
            out: mockOutput(),
            api: mockCommandPlatformApi({ response: { status: 200, body: {} } }),
            cliSettings: mockCommandSettings({ workdir }),
          }),
          Stdio.layerTest({ args: Effect.succeed(args) }),
        ),
      ),
    );
    expect(reached).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
