import { Command } from "effect/unstable/cli";

import { inspectRealtimeBroadcastCommand } from "./broadcast/broadcast.command.ts";
import { inspectRealtimeCheckCommand } from "./check/check.command.ts";
import { inspectRealtimeListenCommand } from "./listen/listen.command.ts";
import { inspectRealtimePresenceCommand } from "./presence/presence.command.ts";

export const inspectRealtimeCommand = Command.make("realtime").pipe(
  Command.withDescription("Debug Realtime connections by joining a channel as a client."),
  Command.withShortDescription("Debug Realtime connections"),
  Command.withSubcommands([
    inspectRealtimeCheckCommand,
    inspectRealtimeListenCommand,
    inspectRealtimeBroadcastCommand,
    inspectRealtimePresenceCommand,
  ]),
);
