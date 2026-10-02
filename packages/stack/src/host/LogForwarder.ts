import {
  Crypto,
  Data,
  Duration,
  Effect,
  FiberMap,
  FileSystem,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import type { CompositionConfig } from "../Orchestrator.ts";
import type { ServiceObservation } from "../Service.ts";
import type { ServiceCreation } from "../services/Catalog.ts";
import type { CatalogError, ServiceEndpoint } from "../services/Recipe.ts";
import { reapStaleWrites, writeFileAtomically } from "../State.ts";
import {
  isShippedService,
  logflareEvent,
  logflareSources,
  type LogflareEvent,
  type ShippedService,
} from "./LogflareEvents.ts";
import type { gatewayLog } from "./GatewayLog.ts";
import { LogPosition, type LogRecord } from "./LogRecord.ts";
import type * as LogStore from "./LogStore.ts";

export interface ForwardedInstance {
  readonly id: string;
  readonly service: ServiceCreation["service"];
  readonly endpoint: (name: string) => Effect.Effect<ServiceEndpoint, CatalogError>;
  /** The current saved creation; Analytics' API key is read from it per body. */
  readonly creation: Effect.Effect<ServiceCreation>;
  readonly observation: Stream.Stream<ServiceObservation<unknown>>;
}

/** An owner log stream without a service instance; it ships while the owner runs. */
export interface ForwardedStream {
  readonly id: string;
  readonly service: typeof gatewayLog.service;
}

interface Interface {
  /**
   * Ships the persisted logs of a shipped service or an owner stream, or tracks an Analytics
   * instance as the target.
   */
  readonly attach: (instance: ForwardedInstance | ForwardedStream) => Effect.Effect<void>;
  /** Stops following an instance; returns once no cursor write of it can still land. */
  readonly detach: (instanceId: string) => Effect.Effect<void>;
  /** Re-selects the shipping target after the composition changes. */
  readonly rebind: Effect.Effect<void>;
  /** Emits whether records are currently shipped; the current value first. */
  readonly shipping: Stream.Stream<boolean>;
}

export interface LogForwarderOptions {
  readonly composition: Effect.Effect<CompositionConfig>;
  readonly logs: LogStore.Interface;
}

interface Candidate {
  readonly instance: ForwardedInstance;
  readonly serving: boolean;
}

interface Target {
  readonly instance: ForwardedInstance;
  readonly epoch: number;
}

/** A shipped event; its id makes a repeated post of the same record a no-op in Logflare. */
interface ShippedEvent extends LogflareEvent {
  readonly id: string;
}

class StaleTarget extends Data.TaggedError("StaleTarget")<{}> {}

const batchEvents = 256;
export const batchBytes = 1024 * 1024;
const envelopeBytes = '{"batch":[]}'.length;
const postTimeout = "5 seconds";
const cursorFile = "cursor.json";
const encoder = new TextEncoder();
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(LogPosition));
const encodeCursor = Schema.encodeEffect(Schema.fromJsonString(LogPosition));
/** Delivery is idempotent per event id, so an unsettled body or a failed log read is retried. */
const retrySchedule = Schedule.exponential("250 millis", 2).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(10))),
  ),
);

const after = (record: LogRecord, cursor: LogPosition | undefined) =>
  cursor === undefined ||
  record.position === undefined ||
  record.position.generation > cursor.generation ||
  (record.position.generation === cursor.generation &&
    record.position.byteOffset > cursor.byteOffset);

/** Groups serialized events into request bodies of at most 256 events and `batchBytes` bytes. */
export const bodies = <A extends { readonly event: ShippedEvent }>(
  events: ReadonlyArray<A>,
): ReadonlyArray<{ readonly body: string; readonly last: A }> => {
  const result: Array<{ readonly body: string; readonly last: A }> = [];
  let current: Array<string> = [];
  let size = envelopeBytes;
  let last: A | undefined;
  const close = () => {
    if (last !== undefined) result.push({ body: `{"batch":[${current.join(",")}]}`, last });
    current = [];
    size = envelopeBytes;
  };
  for (const item of events) {
    const serialized = JSON.stringify(item.event);
    const bytes = encoder.encode(serialized).length;
    if (current.length > 0 && (current.length >= batchEvents || size + 1 + bytes > batchBytes))
      close();
    size += (current.length > 0 ? 1 : 0) + bytes;
    current.push(serialized);
    last = item;
  }
  if (current.length > 0) close();
  return result;
};

const rejectedStatus = (error: unknown): number | undefined =>
  error instanceof HttpClientError.HttpClientError && error.reason._tag === "StatusCodeError"
    ? error.reason.response.status
    : undefined;

/** The target refused its credentials or route, so no body can succeed until it changes. */
const isTargetRejection = (error: unknown): boolean =>
  [401, 403, 404].includes(rejectedStatus(error) ?? 0);

/** The body itself was refused and cannot succeed on a repeat. */
const isBodyRejection = (error: unknown): boolean => {
  const status = rejectedStatus(error);
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    ![401, 403, 404, 408, 429].includes(status)
  );
};

/**
 * Ships persisted service logs to Analytics' direct backend while the composed Analytics instance
 * is running and healthy. Each instance resumes from its cursor, so records written while
 * Analytics sleeps are shipped after it wakes; shipping never wakes Analytics.
 */
export const make = Effect.fn("LogForwarder.make")(function* (options: LogForwarderOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const candidates = yield* Ref.make<ReadonlyMap<string, Candidate>>(new Map());
  const target = yield* SubscriptionRef.make<Target | undefined>(undefined);
  const epochs = yield* Ref.make(0);
  const rebinding = yield* Semaphore.make(1);

  const rebind = Effect.gen(function* () {
    const members = new Set((yield* options.composition).members.map(({ id }) => id));
    const serving = [...(yield* Ref.get(candidates)).values()].find(
      (candidate) => candidate.serving && members.has(candidate.instance.id),
    );
    const previous = yield* SubscriptionRef.get(target);
    if (serving?.instance === previous?.instance) return;
    const epoch = yield* Ref.updateAndGet(epochs, (value) => value + 1);
    yield* SubscriptionRef.set(
      target,
      serving === undefined ? undefined : { instance: serving.instance, epoch },
    );
  }).pipe(Semaphore.withPermits(rebinding, 1));

  const trackTarget = (instance: ForwardedInstance) =>
    instance.observation.pipe(
      Stream.takeUntil((observation) => !observation.registered),
      Stream.runForEach((observation) =>
        Ref.update(candidates, (current) =>
          new Map(current).set(instance.id, {
            instance,
            serving: observation.lifecycle === "running" && observation.health === "healthy",
          }),
        ).pipe(Effect.andThen(rebind)),
      ),
      Effect.ensuring(
        Ref.update(candidates, (current) => {
          const next = new Map(current);
          next.delete(instance.id);
          return next;
        }).pipe(Effect.andThen(rebind)),
      ),
    );

  const serving = SubscriptionRef.changes(target).pipe(
    Stream.filter((current) => current !== undefined),
    Stream.take(1),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
    Effect.orDie,
  );
  const retargeted = (current: Target) =>
    SubscriptionRef.changes(target).pipe(
      Stream.filter((latest) => latest?.epoch !== current.epoch),
      Stream.take(1),
      Stream.runDrain,
    );
  const requireCurrent = (current: Target) =>
    SubscriptionRef.get(target).pipe(
      Effect.flatMap((latest) =>
        latest?.epoch === current.epoch ? Effect.void : Effect.fail(new StaleTarget()),
      ),
    );

  /** A missing or unreadable cursor ships from the oldest retained segment. */
  const readCursor = (directory: string) =>
    fs.readFileString(path.join(directory, cursorFile)).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(Option.none<string>()),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed<LogStore.ReadOptions["from"]>("oldest"),
          onSome: (text) => decodeCursor(text),
        }),
      ),
      Effect.catch(() =>
        Effect.logWarning(
          `Unreadable log cursor in ${directory}; shipping from the oldest retained record`,
        ).pipe(Effect.as<LogStore.ReadOptions["from"]>("oldest")),
      ),
    );
  const writeCursor = (directory: string, position: LogPosition) =>
    encodeCursor(position).pipe(
      Effect.flatMap((content) =>
        writeFileAtomically(fs, path, {
          directory,
          target: path.join(directory, cursorFile),
          content,
        }),
      ),
    );

  const eventId = Effect.fnUntraced(function* (instanceId: string, position: LogPosition) {
    const digest = yield* crypto.digest(
      "SHA-256",
      encoder.encode(`${instanceId}\0${position.generation}\0${position.byteOffset}`),
    );
    const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0"));
    hex[6] = `8${(hex[6] ?? "00").slice(1)}`;
    hex[8] = ((Number.parseInt(hex[8] ?? "00", 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
    const text = hex.join("");
    return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
  });

  const post = Effect.fn("LogForwarder.post")(function* (
    current: Target,
    source: string,
    body: string,
  ) {
    yield* requireCurrent(current);
    const creation = yield* current.instance.creation;
    const apiKey = creation.service === "analytics" ? creation.config.apiKey : undefined;
    if (apiKey === undefined) return yield* new StaleTarget();
    const endpoint = yield* current.instance.endpoint("http");
    yield* client
      .execute(
        HttpClientRequest.post(
          `http://${endpoint.host ?? "127.0.0.1"}:${endpoint.port}/api/logs`,
        ).pipe(
          HttpClientRequest.setUrlParam("source_name", source),
          HttpClientRequest.setHeader("x-api-key", apiKey),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeout(postTimeout),
      );
  });

  /**
   * Posts one body until it settles; the cursor passes it only afterwards. A rejected target pauses
   * shipping until the next retarget, and a rejected body is skipped.
   */
  const deliver = Effect.fnUntraced(function* (current: Target, source: string, body: string) {
    const warned = yield* Ref.make(false);
    yield* post(current, source, body).pipe(
      Effect.catchIf(isTargetRejection, (error) =>
        Effect.logWarning(`Analytics refused ${source} logs; pausing until it changes`, error).pipe(
          Effect.andThen(Effect.fail(new StaleTarget())),
        ),
      ),
      Effect.tapError((error) =>
        error._tag === "StaleTarget" || isBodyRejection(error)
          ? Effect.void
          : Ref.getAndSet(warned, true).pipe(
              Effect.flatMap((already) =>
                already
                  ? Effect.void
                  : Effect.logWarning(`Posting ${source} logs failed; retrying`, error),
              ),
            ),
      ),
      Effect.retry({
        schedule: retrySchedule,
        while: (error) => error._tag !== "StaleTarget" && !isBodyRejection(error),
      }),
      Effect.catch((error) =>
        error._tag === "StaleTarget"
          ? Effect.fail(error)
          : Effect.logWarning(`Analytics rejected a ${source} log body; skipping it`, error),
      ),
    );
  });

  /** Ships one instance's records from its cursor until the target changes. */
  const session = (
    instanceId: string,
    service: ShippedService,
    current: Target,
    failing: Ref.Ref<boolean>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* options.logs.directory(instanceId);
        const from = yield* readCursor(directory);
        const cursor = yield* Ref.make<LogPosition | undefined>(
          typeof from === "string" ? undefined : from,
        );
        const records = yield* options.logs.read(instanceId, { from, follow: true });
        const source = logflareSources[service];
        yield* records.pipe(
          Stream.runForEachArray((page) =>
            Effect.gen(function* () {
              const shipped = yield* Ref.get(cursor);
              const pending: Array<{
                readonly event: ShippedEvent;
                readonly position: LogPosition;
              }> = [];
              for (const record of page) {
                if (record.position === undefined) {
                  yield* Effect.logWarning(
                    `Logs of ${service} instance ${instanceId} were deleted before shipping; resuming from the next retained record`,
                  );
                  continue;
                }
                if (!after(record, shipped)) continue;
                if (record.kind !== "stdout" && record.kind !== "stderr") continue;
                pending.push({
                  position: record.position,
                  event: {
                    id: yield* eventId(instanceId, record.position),
                    ...logflareEvent(service, record.timestamp, record.text ?? ""),
                  },
                });
              }
              for (const { body, last } of bodies(pending)) {
                yield* deliver(current, source, body);
                yield* Ref.set(cursor, last.position);
                yield* Ref.set(failing, false);
                // Detaching waits for a started write instead of leaving files in the directory.
                yield* writeCursor(directory, last.position).pipe(
                  Effect.catch((error) =>
                    Effect.logDebug(`Log cursor of ${instanceId} was not saved`, error),
                  ),
                  Effect.uninterruptible,
                );
              }
            }),
          ),
        );
      }),
    );

  const unregistered = (instance: ForwardedInstance) =>
    instance.observation.pipe(
      Stream.filter((observation) => !observation.registered),
      Stream.take(1),
      Stream.runDrain,
    );

  /**
   * Ships until the instance unregisters (`until`) or the store detaches its logs, which ends a
   * session.
   */
  const forward = (id: string, service: ShippedService, until: Effect.Effect<void>) =>
    Effect.gen(function* () {
      while (true) {
        const current = yield* serving;
        const failing = yield* Ref.make(false);
        // A stopped or refused target pauses shipping until it changes; a failed log read resumes
        // from the cursor after a backoff.
        const detached = yield* session(id, service, current, failing).pipe(
          Effect.tapError((error) =>
            error._tag === "StaleTarget"
              ? Effect.void
              : Ref.getAndSet(failing, true).pipe(
                  Effect.flatMap((already) =>
                    already
                      ? Effect.void
                      : Effect.logWarning(`Reading ${id} logs to ship failed; retrying`, error),
                  ),
                ),
          ),
          Effect.retry({
            schedule: retrySchedule,
            while: (error) => error._tag !== "StaleTarget",
          }),
          Effect.as(true),
          Effect.catch(() => retargeted(current).pipe(Effect.as(false))),
          Effect.raceFirst(retargeted(current).pipe(Effect.as(false))),
        );
        if (detached) return yield* Effect.logDebug(`Log shipping of ${id} stopped with its logs`);
      }
    }).pipe(Effect.raceFirst(until));

  const followers = yield* FiberMap.make<string>();
  const attach = Effect.fn("LogForwarder.attach")(function* (
    instance: ForwardedInstance | ForwardedStream,
  ) {
    if (instance.service === "analytics")
      yield* FiberMap.run(followers, instance.id, trackTarget(instance));
    else if (isShippedService(instance.service)) {
      // A cursor write cut short by a crash leaves its temporary directory behind.
      yield* options.logs.directory(instance.id).pipe(
        Effect.flatMap((directory) => reapStaleWrites(fs, path, directory)),
        Effect.ignore,
      );
      yield* FiberMap.run(
        followers,
        instance.id,
        forward(
          instance.id,
          instance.service,
          "observation" in instance ? unregistered(instance) : Effect.never,
        ),
      );
    }
  });

  return {
    attach,
    detach: (instanceId) => FiberMap.remove(followers, instanceId),
    rebind,
    shipping: SubscriptionRef.changes(target).pipe(
      Stream.map((current) => current !== undefined),
      Stream.changes,
    ),
  } satisfies Interface;
});
