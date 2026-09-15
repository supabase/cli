import { Effect, Option, Stream } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { requirePositive } from "../realtime.flags.ts";
import type { RealtimeCategory } from "../realtime.events.ts";
import {
  describeRealtimeConnection,
  realtimeSessionSpecOf,
  runRealtimeCommand,
  warnRealtimeChannelPrefix,
} from "../realtime.prelude.ts";
import { RealtimeSessions } from "../realtime-session.service.ts";
import type { LegacyInspectRealtimePresenceFlags } from "./presence.command.ts";

const PRESENCE_CATEGORIES: ReadonlySet<RealtimeCategory> = new Set<RealtimeCategory>([
  "presence",
  "system",
  "error",
]);

export const inspectRealtimePresence = Effect.fn("inspect.realtime.presence")(function* (
  flags: LegacyInspectRealtimePresenceFlags,
) {
  const output = yield* Output;
  const sessions = yield* RealtimeSessions;

  return yield* runRealtimeCommand({
    flags,
    prepare: Effect.all({
      timeout: requirePositive("timeout", flags.timeout),
      state: Effect.succeed(
        Option.map(flags.as, (name) => ({ name, online_at: new Date().toISOString() })),
      ),
    }),
    run: (prepared, connection) =>
      Effect.gen(function* () {
        const presenceKey = Option.getOrElse(flags.as, () => "supabase-cli");

        yield* warnRealtimeChannelPrefix(flags.channel);

        const spec = realtimeSessionSpecOf({
          connection,
          flags,
          channel: flags.channel,
          categories: PRESENCE_CATEGORIES,
          logLevel: flags.logLevel,
          postgres: undefined,
          presence: true,
          ...(Option.isNone(prepared.state) ? {} : { presenceKey }),
          broadcastSelf: false,
          broadcastAck: false,
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

            const synced = yield* Effect.gen(function* () {
              if (Option.isNone(prepared.state)) {
                return yield* Stream.runHead(
                  session.events.pipe(
                    Stream.filter(
                      (event) => event.category === "presence" && event.event === "sync",
                    ),
                  ),
                ).pipe(Effect.map(Option.isSome));
              }

              yield* session.track(prepared.state.value);
              yield* session.events.pipe(
                Stream.filter((event) => event.category === "presence"),
                Stream.runForEachWhile(() =>
                  Effect.map(session.presenceState, (state) => state[presenceKey] === undefined),
                ),
              );
              return true;
            }).pipe(
              Effect.timeoutOrElse({
                duration: spec.joinTimeout,
                orElse: () => Effect.succeed(false),
              }),
            );

            const state = yield* session.presenceState;
            const members = Object.entries(state).map(([key, entries]) => ({
              key,
              count: entries.length,
              entries,
            }));

            if (output.format === "text") {
              yield* output.info(describeRealtimeConnection(connection));
              if (!synced) {
                yield* output.warn(
                  Option.isNone(prepared.state)
                    ? "The server sent no presence state; the channel may not have presence enabled."
                    : `This session's presence did not appear under "${presenceKey}" within ${flags.timeout}s; the state below may be incomplete.`,
                );
              }
              yield* output.raw(`${legacyFormatPresenceState(members)}\n`);
            }

            if (output.format !== "text") {
              yield* output.success("Presence read.", {
                channel: spec.channel,
                url: spec.url,
                source: connection.target.source,
                tracked: Option.isSome(prepared.state),
                members: members.length,
                presence: state,
              });
              return;
            }

            yield* output.outro(
              members.length === 0
                ? `Nobody is present on "${spec.channel}".`
                : `${members.length} member${members.length === 1 ? "" : "s"} present on "${spec.channel}".`,
            );
          }),
        );
      }),
  });
});

function legacyFormatPresenceState(
  members: ReadonlyArray<{ readonly key: string; readonly count: number }>,
): string {
  if (members.length === 0) return "(nobody present)";
  return members
    .map((member) => `${member.key}  ${member.count} connection${member.count === 1 ? "" : "s"}`)
    .join("\n");
}
