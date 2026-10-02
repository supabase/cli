import {
  Clock,
  Crypto,
  Data,
  Duration,
  Effect,
  Exit,
  FiberMap,
  FileSystem,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  Scope,
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

export class StoredEventsError extends Schema.TaggedError<StoredEventsError>()(
  "StoredEventsError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** Which shipped events an Analytics instance has stored. */
export interface StoredEvents {
  /** The subset of `ids` stored for `source`. */
  readonly storedIds: (
    source: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlySet<string>, StoredEventsError>;
}

interface Interface {
  /** Ships a shipped service's persisted logs, or tracks an Analytics instance as the target. */
  readonly attach: (instance: ForwardedInstance) => Effect.Effect<void>;
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
  /** Opens the stored-event view of an Analytics target; its scope closes when the target changes. */
  readonly storedEvents: (
    analytics: ForwardedInstance,
  ) => Effect.Effect<StoredEvents, never, Scope.Scope>;
}

interface Candidate {
  readonly instance: ForwardedInstance;
  readonly serving: boolean;
}

interface Target {
  readonly instance: ForwardedInstance;
  readonly epoch: number;
  readonly stored: StoredEvents;
}

/** A shipped event; its id derives from the instance and record position. */
interface ShippedEvent extends LogflareEvent {
  readonly id: string;
}

class StaleTarget extends Data.TaggedError("StaleTarget")<{}> {}

/** A body handed to Analytics whose events are not all confirmed stored yet. */
const Pending = Schema.Struct({
  ...LogPosition.fields,
  source: Schema.String,
  sentAt: Schema.Finite,
  ids: Schema.Array(Schema.String),
});
interface Pending extends Schema.Schema.Type<typeof Pending> {}

/** The last confirmed position, if any, and the pending body after it. */
const Cursor = Schema.Union([
  Schema.Struct({ ...LogPosition.fields, pending: Schema.optionalKey(Pending) }),
  Schema.Struct({ pending: Pending }),
]);
type Cursor = Schema.Schema.Type<typeof Cursor>;

interface Progress {
  readonly confirmed: LogPosition | undefined;
  readonly pending: Pending | undefined;
}

/** One instance's shipping against one target. */
interface Session {
  readonly instanceId: string;
  readonly service: ShippedService;
  readonly directory: string;
  readonly current: Target;
  readonly progress: Ref.Ref<Progress>;
  /** Held while a post is in flight. */
  readonly posting: Semaphore.Semaphore;
}

type Delivery = "sent" | "unsettled" | "refused" | "rejected";

const batchEvents = 256;
export const batchBytes = 1024 * 1024;
/**
 * How long after a post a missing event counts as dropped and is resent; Logflare flushes its
 * per-source batches within about a second.
 */
export const flushWindowMillis = 5_000;
/** How often stored ids are checked while a body is unconfirmed. */
export const pollMillis = 250;
const envelopeBytes = '{"batch":[]}'.length;
const postTimeout = "5 seconds";
const cursorFile = "cursor.json";
const encoder = new TextEncoder();
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeEffect(Schema.fromJsonString(Cursor));
const retrySchedule = Schedule.exponential("250 millis", 2).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(10))),
  ),
);

const after = (position: LogPosition, cursor: LogPosition | undefined) =>
  cursor === undefined ||
  position.generation > cursor.generation ||
  (position.generation === cursor.generation && position.byteOffset > cursor.byteOffset);

const positionOf = ({ generation, byteOffset }: LogPosition): LogPosition => ({
  generation,
  byteOffset,
});

const progressOf = (cursor: Cursor): Progress => ({
  confirmed: "generation" in cursor ? positionOf(cursor) : undefined,
  pending: cursor.pending,
});

const cursorOf = ({ confirmed, pending }: Progress): Cursor | undefined => {
  if (confirmed !== undefined) return pending === undefined ? confirmed : { ...confirmed, pending };
  return pending === undefined ? undefined : { pending };
};

interface Body<A> {
  readonly body: string;
  readonly items: ReadonlyArray<A>;
  readonly last: A;
}

/** Groups serialized events into request bodies of at most 256 events and `batchBytes` bytes. */
export const bodies = <A extends { readonly event: ShippedEvent }>(
  events: ReadonlyArray<A>,
): ReadonlyArray<Body<A>> => {
  const result: Array<Body<A>> = [];
  let current: Array<string> = [];
  let items: Array<A> = [];
  let size = envelopeBytes;
  const close = () => {
    const last = items.at(-1);
    if (last !== undefined) result.push({ body: `{"batch":[${current.join(",")}]}`, items, last });
    current = [];
    items = [];
    size = envelopeBytes;
  };
  for (const item of events) {
    const serialized = JSON.stringify(item.event);
    const bytes = encoder.encode(serialized).length;
    if (current.length > 0 && (current.length >= batchEvents || size + 1 + bytes > batchBytes))
      close();
    size += (current.length > 0 ? 1 : 0) + bytes;
    current.push(serialized);
    items.push(item);
  }
  close();
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

const warnOnce = (warned: Ref.Ref<boolean>, message: string, error: unknown) =>
  Ref.getAndSet(warned, true).pipe(
    Effect.flatMap((already) => (already ? Effect.void : Effect.logWarning(message, error))),
  );

/** Retries with the shared backoff, warning on the first failure only. */
const retryWarningOnce =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Ref.make(false).pipe(
      Effect.flatMap((warned) =>
        effect.pipe(
          Effect.tapError((error) => warnOnce(warned, message, error)),
          Effect.retry(retrySchedule),
        ),
      ),
    );

/**
 * Ships persisted service logs to Analytics' direct backend while the composed Analytics instance
 * is running and healthy. Each instance resumes from its cursor, so records written while
 * Analytics sleeps are shipped after it wakes; shipping never wakes Analytics. Logflare accepts a
 * post before storing it and drops a whole batch holding an already stored id, so the cursor
 * passes a body only once `storedEvents` reports all of it, and only missing events are posted.
 */
export const make = Effect.fn("LogForwarder.make")(function* (options: LogForwarderOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const forwarderScope = yield* Effect.scope;
  const candidates = yield* Ref.make<ReadonlyMap<string, Candidate>>(new Map());
  const target = yield* SubscriptionRef.make<Target | undefined>(undefined);
  const targetScope = yield* Ref.make<Scope.Closeable | undefined>(undefined);
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
    const scope = serving === undefined ? undefined : yield* Scope.fork(forwarderScope);
    const next =
      serving === undefined || scope === undefined
        ? undefined
        : {
            instance: serving.instance,
            epoch,
            stored: yield* options.storedEvents(serving.instance).pipe(Scope.provide(scope)),
          };
    const retired = yield* Ref.getAndSet(targetScope, scope);
    yield* SubscriptionRef.set(target, next);
    if (retired !== undefined) yield* Scope.close(retired, Exit.void);
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
          onNone: () => Effect.succeed<Progress>({ confirmed: undefined, pending: undefined }),
          onSome: (text) => decodeCursor(text).pipe(Effect.map(progressOf)),
        }),
      ),
      Effect.catch(() =>
        Effect.logWarning(
          `Unreadable log cursor in ${directory}; shipping from the oldest retained record`,
        ).pipe(Effect.as<Progress>({ confirmed: undefined, pending: undefined })),
      ),
    );
  const writeCursor = Effect.fnUntraced(function* (directory: string, progress: Progress) {
    const cursor = cursorOf(progress);
    const target = path.join(directory, cursorFile);
    if (cursor === undefined) return yield* fs.remove(target, { force: true });
    const content = yield* encodeCursor(cursor);
    yield* writeFileAtomically(fs, path, { directory, target, content });
  });

  /** Saves progress before acting on it, so the in-memory position never passes the file. */
  const persist = (session: Session, next: Progress) =>
    writeCursor(session.directory, next).pipe(
      // Detaching waits for a started write instead of leaving files in the directory.
      Effect.uninterruptible,
      retryWarningOnce(`Saving the log cursor of ${session.instanceId} failed; retrying`),
      Effect.andThen(Ref.set(session.progress, next)),
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

  /** The event of an output record, or `undefined` for markers and deletion gaps. */
  const shippedEvent = Effect.fnUntraced(function* (session: Session, record: LogRecord) {
    if (record.position === undefined || (record.kind !== "stdout" && record.kind !== "stderr"))
      return undefined;
    const shipped: { readonly position: LogPosition; readonly event: ShippedEvent } = {
      position: record.position,
      event: {
        id: yield* eventId(session.instanceId, record.position),
        ...logflareEvent(session.service, record.timestamp, record.text ?? ""),
      },
    };
    return shipped;
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

  /** Posts one body once and classifies the answer. */
  const deliver = (session: Session, source: string, body: string, warned: Ref.Ref<boolean>) =>
    post(session.current, source, body).pipe(
      session.posting.withPermits(1),
      Effect.as<Delivery>("sent"),
      Effect.catchIf(isTargetRejection, (error) =>
        Effect.logWarning(`Analytics refused ${source} logs; pausing until it changes`, error).pipe(
          Effect.as<Delivery>("refused"),
        ),
      ),
      Effect.catch((error) => {
        if (error._tag === "StaleTarget") return Effect.fail(error);
        if (isBodyRejection(error))
          return Effect.logWarning(
            `Analytics rejected a ${source} log body; skipping it`,
            error,
          ).pipe(Effect.as<Delivery>("rejected"));
        return warnOnce(warned, `Posting ${source} logs failed; retrying`, error).pipe(
          Effect.as<Delivery>("unsettled"),
        );
      }),
    );

  /**
   * Advances past a pending body once Analytics stored all its events. Missing events are posted;
   * after a post, those still missing once `flushWindowMillis` passes are posted again. A refused
   * target clears the body and pauses; a rejected body is skipped.
   */
  const settle = Effect.fnUntraced(function* (
    session: Session,
    initial: Pending,
    events: ReadonlyMap<string, ShippedEvent>,
    alreadyPosted: boolean,
  ) {
    const warned = yield* Ref.make(false);
    let pending = initial;
    let posted = alreadyPosted;
    let due = posted ? pending.sentAt + flushWindowMillis : 0;
    settling: while (true) {
      const stored = yield* session.current.stored
        .storedIds(pending.source, pending.ids)
        .pipe(
          retryWarningOnce(
            `Checking which ${pending.source} logs Analytics stored failed; retrying`,
          ),
        );
      const missing = pending.ids.filter((id) => !stored.has(id));
      if (missing.length === 0) break;
      const now = yield* Clock.currentTimeMillis;
      if (now < due) {
        yield* Effect.sleep(pollMillis);
        continue;
      }
      const resend = missing.flatMap((id) => {
        const event = events.get(id);
        return event === undefined ? [] : [{ event }];
      });
      if (resend.length < missing.length) {
        yield* Effect.logWarning(
          `Logs of ${session.service} instance ${session.instanceId} were deleted before Analytics stored them; skipping ${missing.length - resend.length} lines`,
        );
        pending = { ...pending, ids: pending.ids.filter((id) => stored.has(id) || events.has(id)) };
      }
      if (resend.length === 0) break;
      if (posted) {
        pending = { ...pending, sentAt: now };
        yield* persist(session, {
          confirmed: (yield* Ref.get(session.progress)).confirmed,
          pending,
        });
      }
      for (const { body } of bodies(resend)) {
        const delivery = yield* deliver(session, pending.source, body, warned);
        if (delivery === "refused") {
          yield* persist(session, {
            confirmed: (yield* Ref.get(session.progress)).confirmed,
            pending: undefined,
          });
          return yield* new StaleTarget();
        }
        if (delivery === "rejected") break settling;
      }
      posted = true;
      due = (yield* Clock.currentTimeMillis) + flushWindowMillis;
    }
    yield* persist(session, { confirmed: positionOf(pending), pending: undefined });
  });

  /** Rebuilds a pending body from its retained records and settles it. */
  const reconcile = Effect.fnUntraced(function* (session: Session, saved: Progress) {
    const { confirmed, pending } = saved;
    if (pending === undefined) return;
    const end = positionOf(pending);
    const wanted = new Set(pending.ids);
    const events = new Map<string, ShippedEvent>();
    yield* Effect.scoped(
      options.logs.read(session.instanceId, { from: confirmed ?? "oldest", follow: false }).pipe(
        Effect.flatMap((records) =>
          records.pipe(
            Stream.takeWhile((record) => {
              const at = record.position ?? record.resumeAt;
              return at === undefined || !after(at, end);
            }),
            Stream.runForEach((record) =>
              shippedEvent(session, record).pipe(
                Effect.map((shipped) => {
                  if (shipped !== undefined && wanted.has(shipped.event.id))
                    events.set(shipped.event.id, shipped.event);
                }),
              ),
            ),
          ),
        ),
      ),
    );
    yield* settle(session, pending, events, true);
  });

  /** Ships one instance's records from its cursor until the target changes. */
  const session = (
    instanceId: string,
    service: ShippedService,
    current: Target,
    failing: Ref.Ref<boolean>,
    posting: Semaphore.Semaphore,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* options.logs.directory(instanceId);
        const saved = yield* readCursor(directory);
        const progress = yield* Ref.make(saved);
        const shipping: Session = { instanceId, service, directory, current, progress, posting };
        yield* reconcile(shipping, saved);
        const from = (yield* Ref.get(progress)).confirmed ?? "oldest";
        const records = yield* options.logs.read(instanceId, { from, follow: true });
        const source = logflareSources[service];
        yield* records.pipe(
          Stream.runForEachArray((page) =>
            Effect.gen(function* () {
              const { confirmed } = yield* Ref.get(progress);
              const unshipped: Array<{
                readonly position: LogPosition;
                readonly event: ShippedEvent;
              }> = [];
              for (const record of page) {
                if (record.position === undefined) {
                  yield* Effect.logWarning(
                    `Logs of ${service} instance ${instanceId} were deleted before shipping; resuming from the next retained record`,
                  );
                  continue;
                }
                if (!after(record.position, confirmed)) continue;
                const shipped = yield* shippedEvent(shipping, record);
                if (shipped !== undefined) unshipped.push(shipped);
              }
              for (const { items, last } of bodies(unshipped)) {
                const pending: Pending = {
                  ...last.position,
                  source,
                  sentAt: yield* Clock.currentTimeMillis,
                  ids: items.map(({ event }) => event.id),
                };
                yield* persist(shipping, {
                  confirmed: (yield* Ref.get(progress)).confirmed,
                  pending,
                });
                yield* settle(
                  shipping,
                  pending,
                  new Map(items.map(({ event }) => [event.id, event])),
                  false,
                );
                yield* Ref.set(failing, false);
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

  /** Ships until the instance unregisters or the store detaches its logs, which ends a session. */
  const forward = (instance: ForwardedInstance, service: ShippedService) =>
    Effect.gen(function* () {
      while (true) {
        const current = yield* serving;
        const failing = yield* Ref.make(false);
        const posting = yield* Semaphore.make(1);
        // A stopped or refused target pauses shipping until it changes; a failed log read resumes
        // from the cursor after a backoff.
        const detached = yield* session(instance.id, service, current, failing, posting).pipe(
          Effect.tapError((error) =>
            error._tag === "StaleTarget"
              ? Effect.void
              : warnOnce(failing, `Reading ${instance.id} logs to ship failed; retrying`, error),
          ),
          Effect.retry({
            schedule: retrySchedule,
            while: (error) => error._tag !== "StaleTarget",
          }),
          Effect.as(true),
          Effect.catch(() => retargeted(current).pipe(Effect.as(false))),
          // A retarget lets a started post finish, so its answer decides the pending body.
          Effect.raceFirst(
            retargeted(current).pipe(Effect.andThen(posting.take(1)), Effect.as(false)),
          ),
        );
        if (detached)
          return yield* Effect.logDebug(`Log shipping of ${instance.id} stopped with its logs`);
      }
    }).pipe(Effect.raceFirst(unregistered(instance)));

  const followers = yield* FiberMap.make<string>();
  const attach = Effect.fn("LogForwarder.attach")(function* (instance: ForwardedInstance) {
    if (instance.service === "analytics")
      yield* FiberMap.run(followers, instance.id, trackTarget(instance));
    else if (isShippedService(instance.service)) {
      // A cursor write cut short by a crash leaves its temporary directory behind.
      yield* options.logs.directory(instance.id).pipe(
        Effect.flatMap((directory) => reapStaleWrites(fs, path, directory)),
        Effect.ignore,
      );
      yield* FiberMap.run(followers, instance.id, forward(instance, instance.service));
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
