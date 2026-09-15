import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { inspectRealtimeCommandHandler } from "../realtime.prelude.ts";
import {
  REALTIME_CONNECTION_FLAGS,
  REALTIME_LOG_FLAGS,
  REALTIME_POSTGRES_FLAGS,
} from "../realtime.flags.ts";
import { inspectRealtimeRuntimeLayer } from "../realtime.layers.ts";
import { inspectRealtimeCheck } from "./check.handler.ts";

const config = {
  ...REALTIME_CONNECTION_FLAGS,
  logLevel: REALTIME_LOG_FLAGS.logLevel,
  ...REALTIME_POSTGRES_FLAGS,
  channel: Argument.string("channel").pipe(
    Argument.withDescription("Channel to verify a join against. (default room_a)"),
    Argument.withDefault("room_a"),
  ),
} as const;

export type LegacyInspectRealtimeCheckFlags = CliCommand.Command.Config.Infer<typeof config>;

export const inspectRealtimeCheckCommand = Command.make("check", config).pipe(
  Command.withDescription(
    "Diagnose a Realtime connection: resolve the endpoint, probe it, and join a channel.",
  ),
  Command.withShortDescription("Diagnose a Realtime connection"),
  Command.withExamples([
    {
      command: "supabase inspect realtime check",
      description: "Verify the resolved project can be reached and joined",
    },
    {
      command: "supabase inspect realtime check --postgres public.messages",
      description: "Also verify that a database-changes subscription can be established",
    },
    {
      command: "supabase inspect realtime check --output-format json",
      description: "Machine-readable diagnosis, exiting non-zero when a step fails",
    },
  ]),
  Command.withHandler(
    inspectRealtimeCommandHandler({
      config,
      telemetryFlags: (flags) => ({
        postgres: flags.postgres,
        filter: flags.filter,
        select: flags.select,
      }),
      handler: inspectRealtimeCheck,
    }),
  ),
  Command.provide(inspectRealtimeRuntimeLayer(["inspect", "realtime", "check"])),
);
