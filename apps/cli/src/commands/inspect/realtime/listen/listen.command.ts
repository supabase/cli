import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { inspectRealtimeCommandHandler } from "../realtime.prelude.ts";
import {
  REALTIME_CONNECTION_FLAGS,
  REALTIME_LOG_FLAGS,
  REALTIME_POSTGRES_FLAGS,
} from "../realtime.flags.ts";
import { inspectRealtimeRuntimeLayer } from "../realtime.layers.ts";
import { inspectRealtimeListen } from "./listen.handler.ts";

const config = {
  ...REALTIME_CONNECTION_FLAGS,
  ...REALTIME_LOG_FLAGS,
  presence: Flag.boolean("presence").pipe(
    Flag.withDescription("Also receive presence state and changes for the channel."),
    Flag.withDefault(false),
  ),
  as: Flag.string("as").pipe(
    Flag.withDescription(
      "Join the channel's presence under this name for as long as the tail runs, so other clients can see this session. Implies --presence.",
    ),
    Flag.optional,
  ),
  ...REALTIME_POSTGRES_FLAGS,
  replaySince: Flag.string("replay-since").pipe(
    Flag.withDescription(
      "Replay persisted broadcasts from this point on join, as a timestamp or an age like 5m. Only messages persisted by realtime.send() or a database trigger replay, not ones broadcast over a socket. Requires --private.",
    ),
    Flag.optional,
  ),
  replayLimit: Flag.integer("replay-limit").pipe(
    Flag.withDescription("Cap how many messages --replay-since replays."),
    Flag.optional,
  ),
  replicationReady: Flag.boolean("replication-ready").pipe(
    Flag.withDescription(
      "Wait for the server to confirm the replication connection, for debugging broadcasts sent from the database.",
    ),
    Flag.withDefault(false),
  ),
  duration: Flag.string("duration").pipe(
    Flag.withDescription(
      "Stop after this long, e.g. 30s, 5m. Listens until interrupted when omitted.",
    ),
    Flag.optional,
  ),
  events: Flag.integer("events").pipe(
    Flag.withDescription("Stop after this many frames have been recorded."),
    Flag.optional,
  ),
  channel: Argument.string("channel").pipe(
    Argument.withDescription("Channel to join. (default room_a)"),
    Argument.withDefault("room_a"),
  ),
} as const;

export type LegacyInspectRealtimeListenFlags = CliCommand.Command.Config.Infer<typeof config>;

export const inspectRealtimeListenCommand = Command.make("listen", config).pipe(
  Command.withDescription(
    "Join a Realtime channel and print every frame it receives until interrupted.",
  ),
  Command.withShortDescription("Tail a Realtime channel"),
  Command.withExamples([
    {
      command: "supabase inspect realtime listen room_a",
      description: "Tail broadcast, presence and system frames on a channel",
    },
    {
      command: "supabase inspect realtime listen --postgres public.messages --event INSERT",
      description: "Watch inserts on a table, waiting for replication to be ready",
    },
    {
      command: "supabase inspect realtime listen room_a --duration 30s --output-format stream-json",
      description: "Record 30 seconds of frames as NDJSON for a script or an agent",
    },
    {
      command:
        "supabase inspect realtime listen room_a --private --email dev@example.com --categories all",
      description: "Join a private channel as a signed-in user and record everything",
    },
  ]),
  Command.withHandler(
    inspectRealtimeCommandHandler({
      config,
      telemetryFlags: (flags) => ({
        presence: flags.presence,
        as: flags.as,
        postgres: flags.postgres,
        filter: flags.filter,
        select: flags.select,
        duration: flags.duration,
        events: flags.events,
        "replay-since": flags.replaySince,
        "replay-limit": flags.replayLimit,
        "replication-ready": flags.replicationReady,
        "full-payload": flags.fullPayload,
        categories: flags.categories,
      }),
      handler: inspectRealtimeListen,
    }),
  ),
  Command.provide(inspectRealtimeRuntimeLayer(["inspect", "realtime", "listen"])),
);
