import { Duration, Effect, Option, Ref, Stream } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import type { RealtimeEvent } from "../realtime.events.ts";
import {
  formatRealtimeHeader,
  formatRealtimeLine,
  realtimeFrameEvent,
  realtimeNoChangesHint,
  realtimeSummaryLine,
  type RealtimeRenderOptions,
} from "../realtime.format.ts";
import {
  parseRealtimeCategories,
  parseRealtimeDuration,
  parseRealtimeReplaySince,
  requirePositive,
  resolveRealtimePostgresSpec,
} from "../realtime.flags.ts";
import { RealtimeInvalidOptionError } from "../realtime.errors.ts";
import {
  describeRealtimeConnection,
  realtimeSessionSpecOf,
  runRealtimeCommand,
  warnRealtimeChannelPrefix,
} from "../realtime.prelude.ts";
import { RealtimeSessions } from "../realtime-session.service.ts";
import type { RealtimePostgresSpec } from "../realtime.session.ts";
import type { LegacyInspectRealtimeListenFlags } from "./listen.command.ts";

type LegacyListenStop = "interrupted" | "duration" | "events";

const SUBSCRIPTION_VERDICT_WAIT = Duration.seconds(5);

export const inspectRealtimeListen = Effect.fn("inspect.realtime.listen")(function* (
  flags: LegacyInspectRealtimeListenFlags,
) {
  const output = yield* Output;
  const sessions = yield* RealtimeSessions;
  const processControl = yield* ProcessControl;

  return yield* runRealtimeCommand({
    flags,
    prepare: Effect.all({
      timeout: requirePositive("timeout", flags.timeout),
      events: Option.match(flags.events, {
        onNone: () => Effect.succeed(Option.none<number>()),
        onSome: (limit) =>
          Effect.map(requirePositive("events", limit), (value) => Option.some(value)),
      }),
      categories: parseRealtimeCategories(flags.categories),
      duration: parseRealtimeDuration(flags.duration),
      replaySince: parseRealtimeReplaySince(flags.replaySince),
      postgres: resolveRealtimePostgresSpec({
        postgres: flags.postgres,
        event: flags.event,
        filter: flags.filter,
        select: flags.select,
      }),
    }),
    run: (prepared, connection) =>
      Effect.gen(function* () {
        if (output.format === "json" && Option.isNone(prepared.duration)) {
          return yield* new RealtimeInvalidOptionError({
            message:
              "listen needs --duration with --output-format json, which emits one object once the tail ends; use --output-format stream-json to stream frames as they arrive.",
          });
        }

        yield* warnRealtimeChannelPrefix(flags.channel);

        const spec = realtimeSessionSpecOf({
          connection,
          flags,
          channel: flags.channel,
          categories: prepared.categories,
          logLevel: flags.logLevel,
          postgres: prepared.postgres,
          presence: flags.presence || Option.isSome(flags.as),
          ...Option.match(flags.as, {
            onNone: () => ({}),
            onSome: (name) => ({ presenceKey: name }),
          }),
          broadcastSelf: true,
          broadcastAck: false,
          broadcastReplay:
            prepared.replaySince === undefined
              ? undefined
              : { since: prepared.replaySince, limit: Option.getOrUndefined(flags.replayLimit) },
          replicationReady: flags.replicationReady,
        });

        const render: RealtimeRenderOptions = { fullPayload: flags.fullPayload };

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* sessions.open(spec);

            const joining =
              output.format === "text"
                ? yield* output.task(`Joining ${flags.channel}...`)
                : undefined;

            yield* session.joined.pipe(Effect.tapError(() => joining?.fail() ?? Effect.void));
            yield* joining?.clear() ?? Effect.void;

            if (output.format === "text") {
              yield* output.info(describeRealtimeConnection(connection));
              yield* output.info(
                describeRealtimeSubscription(spec.channel, flags, prepared.postgres),
              );
              yield* output.raw(`${formatRealtimeHeader()}\n`);
            }

            if (prepared.postgres !== undefined) {
              const subscribed = yield* session.postgresSubscribed.pipe(
                Effect.as("ok" as const),
                Effect.catchTag("RealtimePostgresSubscriptionFailedError", (cause) =>
                  Effect.succeed(cause.message),
                ),
                Effect.timeoutOrElse({
                  duration: SUBSCRIPTION_VERDICT_WAIT,
                  orElse: () => Effect.succeed("unconfirmed" as const),
                }),
              );

              if (subscribed === "unconfirmed") {
                yield* output.warn(
                  "The server has not confirmed the database subscription; changes may not arrive.",
                );
              } else if (subscribed !== "ok") {
                yield* output.warn(
                  `No database changes will arrive: ${subscribed}. Check that the table is added to the supabase_realtime publication.`,
                );
              }
            }

            if (flags.replicationReady) {
              const established = yield* session.replicationEstablished.pipe(
                Effect.as("ok" as const),
                Effect.catchTag("RealtimePostgresSubscriptionFailedError", (cause) =>
                  Effect.succeed(cause.message),
                ),
                Effect.timeoutOrElse({
                  duration: SUBSCRIPTION_VERDICT_WAIT,
                  orElse: () => Effect.succeed("unconfirmed" as const),
                }),
              );

              if (established !== "ok") {
                yield* output.warn(
                  established === "unconfirmed"
                    ? "The server has not confirmed the replication connection; broadcasts sent from the database may not arrive."
                    : `The replication connection was not established: ${established}.`,
                );
              }
            }

            if (Option.isSome(flags.as)) {
              yield* session.track({
                name: flags.as.value,
                online_at: new Date().toISOString(),
              });
            }

            const byCategory = yield* Ref.make<Record<string, number>>({});

            const emit = (event: RealtimeEvent) =>
              Effect.gen(function* () {
                yield* Ref.update(byCategory, (counts) => ({
                  ...counts,
                  [event.category]: (counts[event.category] ?? 0) + 1,
                }));

                if (output.format === "text") {
                  yield* output.raw(`${formatRealtimeLine(event, render)}\n`);
                  return;
                }
                yield* output.event(realtimeFrameEvent(event, render));
              });

            const tail = Option.match(prepared.events, {
              onNone: () => session.events,
              onSome: (limit) => Stream.take(session.events, limit),
            }).pipe(Stream.runForEach(emit));

            const stop = yield* Effect.raceAll([
              tail.pipe(Effect.as<LegacyListenStop>("events")),
              processControl
                .awaitSignal(["SIGINT", "SIGTERM"])
                .pipe(Effect.as<LegacyListenStop>("interrupted")),
              ...Option.match(prepared.duration, {
                onNone: () => [],
                onSome: (limit) => [
                  Effect.sleep(limit).pipe(Effect.as<LegacyListenStop>("duration")),
                ],
              }),
            ]);

            const counts = yield* session.counts;
            const summary = {
              emitted: counts.emitted,
              suppressed: counts.suppressed,
              byCategory: yield* Ref.get(byCategory),
            };

            if (output.format === "text") {
              if (prepared.postgres !== undefined && (summary.byCategory["postgres"] ?? 0) === 0) {
                yield* output.warn(
                  realtimeNoChangesHint({
                    table: `${prepared.postgres.schema}.${prepared.postgres.table}`,
                    filtered: prepared.postgres.filter !== undefined,
                    elevated: connection.target.elevated,
                    asUser: connection.userToken !== undefined,
                  }),
                );
              }
              yield* output.outro(`${realtimeSummaryLine(summary)} ${describeRealtimeStop(stop)}`);
              return;
            }

            yield* output.success("Realtime tail complete.", {
              channel: spec.channel,
              url: spec.url,
              source: connection.target.source,
              stoppedBy: stop,
              frames: summary.emitted,
              suppressed: summary.suppressed,
              byCategory: summary.byCategory,
            });
          }),
        );
      }),
  });
});

function describeRealtimeStop(stop: LegacyListenStop): string {
  switch (stop) {
    case "duration":
      return "Stopped at the requested duration.";
    case "events":
      return "Stopped after the requested number of frames.";
    default:
      return "Stopped on interrupt.";
  }
}

function describeRealtimeSubscription(
  channel: string,
  flags: LegacyInspectRealtimeListenFlags,
  postgres: RealtimePostgresSpec | undefined,
): string {
  const parts = ["broadcast"];
  if (flags.presence || Option.isSome(flags.as)) parts.push("presence");
  if (postgres !== undefined) {
    const what = postgres.event === "*" ? "all changes" : postgres.event;
    parts.push(`${what} on ${postgres.schema}.${postgres.table}`);
  }
  const visibility = flags.private ? "private" : "public";
  return `Listening on ${visibility} channel "${channel}" for ${parts.join(", ")}.`;
}
