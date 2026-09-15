import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { inspectRealtimeCommandHandler } from "../realtime.prelude.ts";
import { REALTIME_CONNECTION_FLAGS, REALTIME_LOG_FLAGS } from "../realtime.flags.ts";
import { inspectRealtimeRuntimeLayer } from "../realtime.layers.ts";
import { inspectRealtimeBroadcast } from "./broadcast.handler.ts";

const config = {
  ...REALTIME_CONNECTION_FLAGS,
  logLevel: REALTIME_LOG_FLAGS.logLevel,
  ack: Flag.boolean("ack").pipe(
    Flag.withDescription(
      "Wait for the server to acknowledge each message before exiting. (default true)",
    ),
    Flag.withDefault(true),
  ),
  count: Flag.integer("count").pipe(
    Flag.withDescription("How many copies of the message to send. (default 1)"),
    Flag.withDefault(1),
  ),
  channel: Argument.string("channel").pipe(Argument.withDescription("Channel to broadcast on.")),
  event: Argument.string("event").pipe(Argument.withDescription("Broadcast event name.")),
  payload: Argument.string("payload").pipe(
    Argument.withDescription("JSON payload to send. (default {})"),
    Argument.withDefault("{}"),
  ),
} as const;

export type LegacyInspectRealtimeBroadcastFlags = CliCommand.Command.Config.Infer<typeof config>;

export const inspectRealtimeBroadcastCommand = Command.make("broadcast", config).pipe(
  Command.withDescription(
    "Send a broadcast message to a Realtime channel and report whether the server took it.",
  ),
  Command.withShortDescription("Send a Realtime broadcast"),
  Command.withExamples([
    {
      command: "supabase inspect realtime broadcast room_a ping '{\"n\":1}'",
      description: "Send one message and wait for the server to acknowledge it",
    },
    {
      command: "supabase inspect realtime broadcast room_a tick --count 10",
      description: "Produce a stream of traffic for another session to observe",
    },
  ]),
  Command.withHandler(
    inspectRealtimeCommandHandler({
      config,
      telemetryFlags: (flags) => ({
        ack: flags.ack,
        count: flags.count,
      }),
      handler: inspectRealtimeBroadcast,
    }),
  ),
  Command.provide(inspectRealtimeRuntimeLayer(["inspect", "realtime", "broadcast"])),
);
