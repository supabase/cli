import { Effect, Layer } from "effect";
import { projectDaemonLayer } from "@supabase/stack/internals";
import { daemonEntryPoint } from "@supabase/stack/bun";
import { BunServices } from "@effect/platform-bun";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { cliConfigLayer } from "../../config/cli-config.layer.ts";
import { CliConfig } from "../../config/cli-config.service.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { Output } from "../../output/output.service.ts";
import { inkLayer } from "../../runtime/ink.layer.ts";
import { runtimeInfoLayer } from "../../runtime/runtime-info.layer.ts";
import { RuntimeInfo } from "../../runtime/runtime-info.service.ts";
import { start } from "./start.handler.ts";

const excludedStartServices = ["auth", "postgrest"] as const;

type ExcludedStartService = (typeof excludedStartServices)[number];

export const excludeFlag = Flag.choice("exclude", excludedStartServices).pipe(
  Flag.atMost(2),
  Flag.withDescription(
    "Services to exclude. Repeat the flag for multiple values (for example: --exclude auth --exclude postgrest)",
  ),
  Flag.withDefault([] as ReadonlyArray<ExcludedStartService>),
);

export function toStartStackConfig(exclude: ReadonlyArray<ExcludedStartService>) {
  const excluded = new Set(exclude);
  return {
    ...(excluded.has("auth") ? { auth: false as const } : {}),
    ...(excluded.has("postgrest") ? { postgrest: false as const } : {}),
  };
}

const flags = {
  exclude: excludeFlag,
  detach: Flag.boolean("detach").pipe(
    Flag.withDescription("Run in background (daemon mode)"),
    Flag.withDefault(false),
  ),
} as const;

export type StartFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const startCommand = Command.make("start", flags).pipe(
  Command.withDescription(
    "Start the local Supabase development stack.\n\n" +
      "Downloads required binaries on first use and starts Postgres, PostgREST, and Auth services.\n\n" +
      "Use --exclude auth --exclude postgrest to skip optional services. Use --detach to run in the background.",
  ),
  Command.withShortDescription("Start local Supabase stack"),
  Command.withExamples([
    {
      command: "supabase start",
      description: "Start the stack in the foreground and watch service status live",
    },
    {
      command: "supabase start --detach",
      description: "Start the stack in the background and return to the shell",
    },
    {
      command: "supabase start --exclude auth --exclude postgrest",
      description: "Start only the core services you need",
    },
  ]),
  Command.withHandler((flags) =>
    start(flags).pipe(Effect.withSpan("command.start"), withJsonErrorHandling),
  ),
  Command.provide((flags) => {
    const daemonLayerEffect = Effect.gen(function* () {
      const output = yield* Output;
      const cliConfig = yield* CliConfig;
      const runtimeInfo = yield* RuntimeInfo;

      yield* output.intro("Start local Supabase stack");

      return yield* projectDaemonLayer({
        home: cliConfig.supabaseHome,
        cwd: runtimeInfo.cwd,
        daemonEntryPoint,
        stackConfig: toStartStackConfig(flags.exclude),
      });
    });

    return Layer.mergeAll(Layer.unwrap(daemonLayerEffect), inkLayer).pipe(
      Layer.provide(cliConfigLayer),
      Layer.provide(runtimeInfoLayer),
      Layer.provide(BunServices.layer),
    );
  }),
);
