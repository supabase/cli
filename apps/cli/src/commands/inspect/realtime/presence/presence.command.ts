import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { inspectRealtimeCommandHandler } from "../realtime.prelude.ts";
import { REALTIME_CONNECTION_FLAGS, REALTIME_LOG_FLAGS } from "../realtime.flags.ts";
import { inspectRealtimeRuntimeLayer } from "../realtime.layers.ts";
import { inspectRealtimePresence } from "./presence.handler.ts";

const config = {
  ...REALTIME_CONNECTION_FLAGS,
  logLevel: REALTIME_LOG_FLAGS.logLevel,
  as: Flag.string("as").pipe(
    Flag.withDescription(
      "Join the channel's presence as this name, so other subscribers can see this session.",
    ),
    Flag.optional,
  ),
  channel: Argument.string("channel").pipe(
    Argument.withDescription("Channel to read presence for. (default room_a)"),
    Argument.withDefault("room_a"),
  ),
} as const;

export type LegacyInspectRealtimePresenceFlags = CliCommand.Command.Config.Infer<typeof config>;

export const inspectRealtimePresenceCommand = Command.make("presence", config).pipe(
  Command.withDescription("Show who is present on a Realtime channel, and optionally join them."),
  Command.withShortDescription("Inspect Realtime presence"),
  Command.withExamples([
    {
      command: "supabase inspect realtime presence room_a",
      description: "Print the current presence state of a channel and exit",
    },
    {
      command: "supabase inspect realtime presence room_a --as debugger",
      description: "Join presence under a name, so other subscribers can see this session",
    },
  ]),
  Command.withHandler(
    inspectRealtimeCommandHandler({
      config,
      telemetryFlags: (flags) => ({
        as: flags.as,
      }),
      handler: inspectRealtimePresence,
    }),
  ),
  Command.provide(inspectRealtimeRuntimeLayer(["inspect", "realtime", "presence"])),
);
