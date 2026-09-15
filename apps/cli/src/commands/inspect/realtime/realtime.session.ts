import {
  REALTIME_SUBSCRIBE_STATES,
  RealtimeClient,
  type RealtimeChannel,
  type RealtimePresenceState,
} from "@supabase/realtime-js";
import { Cause, Deferred, Duration, Effect, Queue, Redacted, Stream } from "effect";

import {
  RealtimeBroadcastFailedError,
  RealtimeInvalidUrlError,
  RealtimeJoinFailedError,
  RealtimePostgresSubscriptionFailedError,
} from "./realtime.errors.ts";
import {
  isRealtimeHeartbeat,
  realtimeCategoryOfLogKind,
  redactRealtimeText,
  unwrapRealtimePayload,
  type RealtimeCategory,
  type RealtimeEvent,
  type RealtimeLogLevel,
} from "./realtime.events.ts";

export type RealtimePostgresEvent = "*" | "INSERT" | "UPDATE" | "DELETE";

export interface RealtimePostgresSpec {
  readonly schema: string;
  readonly table: string;
  readonly event: RealtimePostgresEvent;
  readonly filter: string | undefined;
  readonly select: ReadonlyArray<string>;
}

export interface RealtimeSessionSpec {
  readonly url: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly userToken: Redacted.Redacted<string> | undefined;
  readonly channel: string;
  readonly privateChannel: boolean;
  readonly broadcastSelf: boolean;
  readonly broadcastAck: boolean;
  readonly broadcastReplay:
    | { readonly since: number; readonly limit: number | undefined }
    | undefined;
  readonly replicationReady: boolean;
  readonly presence: boolean;
  readonly presenceKey: string | undefined;
  readonly postgres: RealtimePostgresSpec | undefined;
  readonly logLevel: RealtimeLogLevel | undefined;
  readonly categories: ReadonlySet<RealtimeCategory>;
  readonly bufferSize: number;
  readonly joinTimeout: Duration.Duration;
}

interface RealtimeSessionCounts {
  readonly emitted: number;
  readonly suppressed: number;
}

export interface RealtimeSession {
  readonly events: Stream.Stream<RealtimeEvent>;
  readonly joined: Effect.Effect<void, RealtimeJoinFailedError>;
  readonly postgresSubscribed: Effect.Effect<void, RealtimePostgresSubscriptionFailedError>;
  readonly replicationEstablished: Effect.Effect<void, RealtimePostgresSubscriptionFailedError>;
  readonly broadcast: (
    event: string,
    payload: unknown,
  ) => Effect.Effect<void, RealtimeBroadcastFailedError>;
  readonly track: (
    state: Record<string, unknown>,
  ) => Effect.Effect<void, RealtimeBroadcastFailedError>;
  readonly presenceState: Effect.Effect<RealtimePresenceState>;
  readonly counts: Effect.Effect<RealtimeSessionCounts>;
}

function realtimeSocketEndpoint(url: string): Effect.Effect<string, RealtimeInvalidUrlError> {
  return Effect.try({
    try: () => {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`unsupported scheme "${parsed.protocol}"`);
      }
      return `${url.replace(/\/+$/, "")}/realtime/v1`;
    },
    catch: (cause) =>
      new RealtimeInvalidUrlError({
        message: `invalid Realtime URL "${url}": ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

export const realtimeSession = Effect.fnUntraced(function* (spec: RealtimeSessionSpec) {
  const endpoint = yield* realtimeSocketEndpoint(spec.url);
  const queue = yield* Queue.sliding<RealtimeEvent, Cause.Done>(spec.bufferSize);
  const joinOutcome = yield* Deferred.make<void, RealtimeJoinFailedError>();
  const postgresOutcome = yield* Deferred.make<void, RealtimePostgresSubscriptionFailedError>();
  const replicationOutcome = yield* Deferred.make<void, RealtimePostgresSubscriptionFailedError>();

  const counts = { emitted: 0, suppressed: 0 };

  const record = (
    category: RealtimeCategory,
    event: string,
    payload: unknown,
    options?: { readonly latencyMs?: number; readonly label?: string },
  ): void => {
    if (!spec.categories.has(category)) {
      counts.suppressed += 1;
      return;
    }
    counts.emitted += 1;
    Queue.offerUnsafe(queue, {
      seq: counts.emitted,
      at: new Date().toISOString(),
      category,
      event: redactRealtimeText(event),
      payload: unwrapRealtimePayload(payload) ?? {},
      ...(options?.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
      ...(options?.label === undefined ? {} : { label: options.label }),
    });
  };

  const joinTimeoutMs = Duration.toMillis(spec.joinTimeout);

  const handle = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new RealtimeClient(endpoint, {
        params: { apikey: Redacted.value(spec.apiKey) },
        ...(spec.logLevel === undefined ? {} : { log_level: spec.logLevel }),
        heartbeatCallback: (status, latency) => {
          record("transport", `heartbeat ${status}`, {}, { latencyMs: latency });
        },
        logger: (kind, message, data) => {
          if (isRealtimeHeartbeat(message)) return;
          record(realtimeCategoryOfLogKind(kind), message, { data });
        },
      });

      if (spec.userToken !== undefined) {
        const token = Redacted.value(spec.userToken);
        yield* Effect.tryPromise({
          try: () => client.setAuth(token),
          catch: (cause) =>
            new RealtimeJoinFailedError({
              reason: "rejected",
              message: `the user token could not be applied: ${realtimeReasonText(cause)}`,
            }),
        });
      }

      const channel = client.channel(spec.channel, {
        config: {
          broadcast: {
            self: spec.broadcastSelf,
            ack: spec.broadcastAck,
            ...(spec.replicationReady ? { replication_ready: true } : {}),
            ...(spec.broadcastReplay === undefined
              ? {}
              : {
                  replay: {
                    since: spec.broadcastReplay.since,
                    ...(spec.broadcastReplay.limit === undefined
                      ? {}
                      : { limit: spec.broadcastReplay.limit }),
                  },
                }),
          },
          presence: {
            enabled: spec.presence,
            ...(spec.presenceKey === undefined ? {} : { key: spec.presenceKey }),
          },
          private: spec.privateChannel,
          ...(spec.postgres === undefined ? {} : { postgres_changes_options: { wait: true } }),
        },
      });

      legacyRegisterRealtimeListeners(channel, spec, record, (extension, status, message) => {
        const outcome =
          status === "ok"
            ? Effect.void
            : Effect.fail(
                new RealtimePostgresSubscriptionFailedError({
                  message:
                    message ??
                    `the server refused the ${extension} subscription without giving a reason`,
                }),
              );
        Deferred.doneUnsafe(
          extension === "postgres_changes" ? postgresOutcome : replicationOutcome,
          outcome,
        );
      });

      channel.subscribe((status, error) => {
        const reason = error === undefined ? undefined : realtimeReasonText(error);
        record("channel", `subscribe ${status}`, reason === undefined ? {} : { reason });

        switch (status) {
          case REALTIME_SUBSCRIBE_STATES.SUBSCRIBED:
            Deferred.doneUnsafe(joinOutcome, Effect.void);
            return;
          case REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR:
            Deferred.doneUnsafe(
              joinOutcome,
              Effect.fail(
                new RealtimeJoinFailedError({
                  reason: "rejected",
                  message: `channel "${spec.channel}" was rejected: ${reason ?? "no reason given"}`,
                }),
              ),
            );
            return;
          case REALTIME_SUBSCRIBE_STATES.TIMED_OUT:
            Deferred.doneUnsafe(
              joinOutcome,
              Effect.fail(
                new RealtimeJoinFailedError({
                  reason: "timed_out",
                  message: `joining channel "${spec.channel}" timed out after ${joinTimeoutMs}ms`,
                }),
              ),
            );
            return;
          default:
            Deferred.doneUnsafe(
              joinOutcome,
              Effect.fail(
                new RealtimeJoinFailedError({
                  reason: "closed",
                  message: `the connection closed before channel "${spec.channel}" joined`,
                }),
              ),
            );
        }
      }, joinTimeoutMs);

      return { client, channel };
    }),
    ({ client }) =>
      Effect.tryPromise(() => client.removeAllChannels()).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.sync(() => {
            Queue.endUnsafe(queue);
          }),
        ),
      ),
  );

  const session: RealtimeSession = {
    events: Stream.fromQueue(queue),
    joined: Deferred.await(joinOutcome).pipe(
      Effect.timeoutOrElse({
        duration: Duration.sum(spec.joinTimeout, Duration.seconds(10)),
        orElse: () =>
          Effect.fail(
            new RealtimeJoinFailedError({
              reason: "timed_out",
              message: `no join result for channel "${spec.channel}" within ${joinTimeoutMs}ms`,
            }),
          ),
      }),
    ),
    postgresSubscribed:
      spec.postgres === undefined
        ? Effect.void
        : Deferred.await(postgresOutcome).pipe(
            Effect.timeoutOrElse({
              duration: Duration.sum(spec.joinTimeout, Duration.seconds(10)),
              orElse: () =>
                Effect.fail(
                  new RealtimePostgresSubscriptionFailedError({
                    message: `the server never confirmed the subscription to ${spec.postgres?.schema}.${spec.postgres?.table}`,
                  }),
                ),
            }),
          ),
    replicationEstablished: !spec.replicationReady
      ? Effect.void
      : Deferred.await(replicationOutcome).pipe(
          Effect.timeoutOrElse({
            duration: Duration.sum(spec.joinTimeout, Duration.seconds(10)),
            orElse: () =>
              Effect.fail(
                new RealtimePostgresSubscriptionFailedError({
                  message:
                    "the server never confirmed that the replication connection was established",
                }),
              ),
          }),
        ),
    broadcast: (event, payload) =>
      realtimeSendResult(
        () => handle.channel.send({ type: "broadcast", event, payload }),
        `broadcast "${event}"`,
      ),
    track: (state) => realtimeSendResult(() => handle.channel.track(state), "presence track"),
    presenceState: Effect.sync(() => handle.channel.presenceState()),
    counts: Effect.sync(() => ({ emitted: counts.emitted, suppressed: counts.suppressed })),
  };

  return session;
});

function realtimeSendResult(
  send: () => Promise<string>,
  what: string,
): Effect.Effect<void, RealtimeBroadcastFailedError> {
  return Effect.tryPromise({
    try: send,
    catch: (cause) =>
      new RealtimeBroadcastFailedError({
        message: `${what} failed: ${realtimeReasonText(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((status) =>
      status === "ok"
        ? Effect.void
        : Effect.fail(
            new RealtimeBroadcastFailedError({
              message: `${what} was not acknowledged: ${status}`,
            }),
          ),
    ),
  );
}

function realtimeReasonText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return redactRealtimeText(text.replace(/^Error:\s*/i, "").trim());
}

function legacyRegisterRealtimeListeners(
  channel: RealtimeChannel,
  spec: RealtimeSessionSpec,
  record: (
    category: RealtimeCategory,
    event: string,
    payload: unknown,
    options?: { readonly latencyMs?: number; readonly label?: string },
  ) => void,
  onSubscriptionStatus: (
    extension: string,
    status: "ok" | "error",
    message: string | undefined,
  ) => void,
): void {
  channel.on("system", {}, (payload) => {
    const extension = typeof payload["extension"] === "string" ? payload["extension"] : "system";
    const status = typeof payload["status"] === "string" ? payload["status"] : undefined;
    const message = typeof payload["message"] === "string" ? payload["message"] : undefined;

    if (status === "ok" || status === "error") {
      onSubscriptionStatus(extension, status, message);
    }

    record(
      "system",
      extension,
      payload,
      status === "error"
        ? { label: "Subscription refused" }
        : status === "ok"
          ? { label: "Subscription confirmed" }
          : undefined,
    );
  });

  channel.on("broadcast", { event: "*" }, (payload) => {
    const event = typeof payload.event === "string" ? payload.event : "broadcast";
    record("broadcast", event, payload);
  });

  if (spec.presence) {
    channel.on("presence", { event: "sync" }, () => {
      record("presence", "sync", { state: channel.presenceState() });
    });
    channel.on("presence", { event: "join" }, (payload) => {
      record("presence", "join", payload);
    });
    channel.on("presence", { event: "leave" }, (payload) => {
      record("presence", "leave", payload);
    });
  }

  const postgres = spec.postgres;
  if (postgres !== undefined) {
    channel.on(
      "postgres_changes",
      {
        event: postgres.event,
        schema: postgres.schema,
        table: postgres.table,
        ...(postgres.filter === undefined ? {} : { filter: postgres.filter }),
        ...(postgres.select.length === 0 ? {} : { select: [...postgres.select] }),
      },
      (payload) => {
        const lag = realtimeCommitLagMs(payload.commit_timestamp);
        record(
          "postgres",
          typeof payload.eventType === "string" ? payload.eventType : "postgres_changes",
          payload,
          lag === undefined ? undefined : { latencyMs: lag },
        );
      },
    );
  }
}

function realtimeCommitLagMs(commitTimestamp: unknown): number | undefined {
  if (typeof commitTimestamp !== "string") return undefined;
  const committedAt = Date.parse(commitTimestamp);
  if (Number.isNaN(committedAt)) return undefined;
  const lag = Date.now() - committedAt;
  return lag < 0 ? undefined : lag;
}
