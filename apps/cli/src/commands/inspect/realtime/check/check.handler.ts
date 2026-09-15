import { Duration, Effect } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { describeRealtimeTarget } from "../realtime.connection.ts";
import { REALTIME_DEFAULT_CATEGORIES } from "../realtime.events.ts";
import {
  RealtimeEndpointUnhealthyError,
  RealtimeKeyRejectedError,
  RealtimePostgresSubscriptionFailedError,
} from "../realtime.errors.ts";
import { requirePositive, resolveRealtimePostgresSpec } from "../realtime.flags.ts";
import {
  realtimeSessionSpecOf,
  runRealtimeCommand,
  warnRealtimeChannelPrefix,
} from "../realtime.prelude.ts";
import { probeRealtimeEndpoint } from "../realtime.probe.ts";
import { RealtimeSessions } from "../realtime-session.service.ts";
import type { LegacyInspectRealtimeCheckFlags } from "./check.command.ts";

interface RealtimeCheckStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly durationMs?: number;
}

export const inspectRealtimeCheck = Effect.fn("inspect.realtime.check")(function* (
  flags: LegacyInspectRealtimeCheckFlags,
) {
  const output = yield* Output;
  const sessions = yield* RealtimeSessions;

  return yield* runRealtimeCommand({
    flags,
    prepare: Effect.all({
      timeout: requirePositive("timeout", flags.timeout),
      postgres: resolveRealtimePostgresSpec({
        postgres: flags.postgres,
        event: flags.event,
        filter: flags.filter,
        select: flags.select,
      }),
    }),
    run: (prepared, connection) =>
      Effect.gen(function* () {
        const steps: Array<RealtimeCheckStep> = [];
        const report = (step: RealtimeCheckStep) =>
          Effect.gen(function* () {
            steps.push(step);
            if (output.format === "text") {
              yield* output.raw(
                `${step.ok ? "✔" : "✘"} ${step.name}: ${step.detail}${
                  step.durationMs === undefined ? "" : ` (${step.durationMs}ms)`
                }\n`,
              );
            }
          });

        yield* report({
          name: "resolve",
          ok: true,
          detail: connection.target.elevated
            ? `using ${describeRealtimeTarget(connection.target)} with the secret key, which bypasses RLS — this says nothing about whether an application user can join`
            : `using ${describeRealtimeTarget(connection.target)}`,
        });

        const probe = yield* probeRealtimeEndpoint(connection.target);
        yield* report({
          name: "reach",
          ok: probe.kind === "reachable",
          detail: probe.detail,
        });

        if (probe.kind !== "reachable") {
          return yield* probe.kind === "unauthorized"
            ? new RealtimeKeyRejectedError({ message: probe.detail })
            : new RealtimeEndpointUnhealthyError({
                kind: probe.kind,
                message: probe.detail,
              });
        }

        yield* warnRealtimeChannelPrefix(flags.channel);

        const spec = realtimeSessionSpecOf({
          connection,
          flags,
          channel: flags.channel,
          categories: new Set(REALTIME_DEFAULT_CATEGORIES),
          logLevel: flags.logLevel,
          postgres: prepared.postgres,
          presence: false,
          broadcastSelf: false,
          broadcastAck: false,
        });

        const attempt = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* sessions.open(spec);

            const joined = yield* Effect.timed(session.joined).pipe(
              Effect.map(([elapsed]) => ({ ok: true as const, elapsed })),
              Effect.catchTag("RealtimeJoinFailedError", (cause) =>
                Effect.succeed({ ok: false as const, message: cause.message }),
              ),
            );
            if (!joined.ok) return { joined } as const;

            const subscribed = yield* Effect.timed(session.postgresSubscribed).pipe(
              Effect.map(([elapsed]) => ({ ok: true as const, elapsed })),
              Effect.catchTag("RealtimePostgresSubscriptionFailedError", (cause) =>
                Effect.succeed({ ok: false as const, message: cause.message }),
              ),
            );
            return { joined, subscribed } as const;
          }),
        );

        if (!attempt.joined.ok) {
          yield* report({ name: "join", ok: false, detail: attempt.joined.message });
          return yield* new RealtimeEndpointUnhealthyError({
            kind: "handshake_refused",
            message: attempt.joined.message,
          });
        }

        yield* report({
          name: "join",
          ok: true,
          detail: `joined "${spec.channel}"`,
          durationMs: Math.round(Duration.toMillis(attempt.joined.elapsed)),
        });

        const postgres = prepared.postgres;
        if (postgres !== undefined) {
          const subscribed = attempt.subscribed;
          const what = `${postgres.event === "*" ? "all changes" : postgres.event} on ${postgres.schema}.${postgres.table}`;

          if (subscribed === undefined || !subscribed.ok) {
            const detail = subscribed?.message ?? "the subscription was never confirmed";
            yield* report({ name: "subscribe", ok: false, detail });
            return yield* new RealtimePostgresSubscriptionFailedError({ message: detail });
          }

          yield* report({
            name: "subscribe",
            ok: true,
            detail: `server is streaming ${what}`,
            durationMs: Math.round(Duration.toMillis(subscribed.elapsed)),
          });
        }

        if (output.format === "text") {
          yield* output.outro("Realtime is reachable and the channel joined.");
          return;
        }

        yield* output.success("Realtime is reachable and the channel joined.", {
          channel: spec.channel,
          url: spec.url,
          source: connection.target.source,
          ...(connection.target.projectRef === undefined
            ? {}
            : { projectRef: connection.target.projectRef }),
          steps,
        });
      }),
  });
});
