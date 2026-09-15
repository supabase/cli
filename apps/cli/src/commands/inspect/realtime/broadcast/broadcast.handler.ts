import { Effect } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { REALTIME_DEFAULT_CATEGORIES } from "../realtime.events.ts";
import { parseRealtimePayload, requirePositive } from "../realtime.flags.ts";
import {
  describeRealtimeConnection,
  realtimeSessionSpecOf,
  runRealtimeCommand,
  warnRealtimeChannelPrefix,
} from "../realtime.prelude.ts";
import { RealtimeSessions } from "../realtime-session.service.ts";
import type { LegacyInspectRealtimeBroadcastFlags } from "./broadcast.command.ts";

export const inspectRealtimeBroadcast = Effect.fn("inspect.realtime.broadcast")(function* (
  flags: LegacyInspectRealtimeBroadcastFlags,
) {
  const output = yield* Output;
  const sessions = yield* RealtimeSessions;

  return yield* runRealtimeCommand({
    flags,
    prepare: Effect.all({
      payload: parseRealtimePayload(flags.payload),
      count: requirePositive("count", flags.count),
      timeout: requirePositive("timeout", flags.timeout),
    }),
    run: (prepared, connection) =>
      Effect.gen(function* () {
        yield* warnRealtimeChannelPrefix(flags.channel);

        const spec = realtimeSessionSpecOf({
          connection,
          flags,
          channel: flags.channel,
          categories: new Set(REALTIME_DEFAULT_CATEGORIES),
          logLevel: flags.logLevel,
          postgres: undefined,
          presence: false,
          broadcastSelf: false,
          broadcastAck: flags.ack,
        });

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* sessions.open(spec);

            const joining =
              output.format === "text"
                ? yield* output.task(`Joining ${flags.channel}...`)
                : undefined;
            yield* session.joined.pipe(Effect.tapError(() => joining?.fail() ?? Effect.void));
            yield* joining?.clear() ?? Effect.void;

            const sending =
              output.format === "text"
                ? yield* output.task(
                    flags.count === 1
                      ? `Sending "${flags.event}"...`
                      : `Sending "${flags.event}" ${flags.count} times...`,
                  )
                : undefined;

            yield* Effect.forEach(
              Array.from({ length: flags.count }, (_, index) => index),
              () => session.broadcast(flags.event, prepared.payload),
              { discard: true },
            ).pipe(Effect.tapError(() => sending?.fail() ?? Effect.void));

            const delivered = flags.ack
              ? `${flags.count === 1 ? "Message" : `${flags.count} messages`} acknowledged by the server.`
              : `${flags.count === 1 ? "Message" : `${flags.count} messages`} sent (not waiting for acknowledgement).`;

            if (output.format === "text") {
              yield* sending?.succeed(delivered) ?? Effect.void;
              yield* output.outro(`${describeRealtimeConnection(connection)} ${delivered}`);
              return;
            }

            yield* output.success(delivered, {
              channel: spec.channel,
              url: spec.url,
              source: connection.target.source,
              event: flags.event,
              count: flags.count,
              acknowledged: flags.ack,
            });
          }),
        );
      }),
  });
});
