import { Effect, Layer } from "effect";
import { projectDaemonLayer } from "@supabase/stack/effect";
import { daemonEntryPoint } from "@supabase/stack";
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

const excludedStartServices = [
  "auth",
  "postgrest",
  "realtime",
  "storage",
  "imgproxy",
  "mailpit",
  "pgmeta",
  "studio",
  "analytics",
  "vector",
  "pooler",
] as const;

type ExcludedStartService = (typeof excludedStartServices)[number];

export const excludeFlag = Flag.choice("exclude", excludedStartServices).pipe(
  Flag.atMost(excludedStartServices.length),
  Flag.withDescription(
    "Services to exclude from the local stack. Repeat the flag for multiple values.",
  ),
  Flag.withDefault([] as ReadonlyArray<ExcludedStartService>),
);

export function toStartStackConfig(exclude: ReadonlyArray<ExcludedStartService>) {
  const excluded = new Set(exclude);
  return {
    mode: "auto" as const,
    realtime: excluded.has("realtime") ? (false as const) : {},
    storage: excluded.has("storage") ? (false as const) : {},
    imgproxy: excluded.has("imgproxy") || excluded.has("storage") ? (false as const) : {},
    mailpit: excluded.has("mailpit") ? (false as const) : {},
    pgmeta: excluded.has("pgmeta") ? (false as const) : {},
    studio: excluded.has("studio") || excluded.has("pgmeta") ? (false as const) : {},
    analytics: excluded.has("analytics") ? (false as const) : {},
    vector: excluded.has("vector") || excluded.has("analytics") ? (false as const) : {},
    pooler: excluded.has("pooler") ? (false as const) : {},
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
      "Starts the full local Supabase stack. Core services prefer native binaries when available and fall back to Docker; legacy services run in Docker for now.\n\n" +
      "Named CLI stacks persist their service data under SUPABASE_HOME/stacks/<name>/data. Use --exclude to skip optional services. Use --detach to run in the background.",
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
      command: "supabase start --exclude studio --exclude analytics",
      description: "Start a slimmer stack without Studio or analytics services",
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
        cacheRoot: cliConfig.supabaseHome,
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
