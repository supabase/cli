import {
  Cause,
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
import { errorCode } from "../internal/sharing-violation.ts";
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

export class StoredEventsError extends Schema.TaggedError<StoredEventsError>()(
  "StoredEventsError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** Which shipped events an Analytics instance has stored. */
export interface StoredEvents {
  /** The subset of `ids` stored for `source`; failures are retried and reported by the view. */
  readonly storedIds: (
    source: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlySet<string>, StoredEventsError>;
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
  /** Opens the stored-event view of an Analytics target; its scope closes when the target changes. */
  readonly storedEvents: (
    analytics: ForwardedInstance,
  ) => Effect.Effect<StoredEvents, never, Scope.Scope>;
}

interface Candidate {
  readonly instance: ForwardedInstance;
  readonly serving: boolean;
  readonly launchId: number | undefined;
}

interface Target {
  readonly instance: ForwardedInstance;
  readonly epoch: number;
  /** Names the Analytics launch; launches seen by different forwarders never share a name. */
  readonly launch: string;
  readonly stored: StoredEvents;
  /** One permit per session using `stored`; the view closes once a retired target has none. */
  readonly users: Semaphore.Semaphore;
  /** Per source, the latest post to this launch, by sequence number, that Analytics stored events of. */
  readonly storedPost: Ref.Ref<ReadonlyMap<string, number>>;
}

/** A shipped event; its id derives from the instance and record position. */
interface ShippedEvent extends LogflareEvent {
  readonly id: string;
}

class StaleTarget extends Data.TaggedError("StaleTarget")<{}> {}

/** A body's end position, source and event ids. */
const Shipment = Schema.Struct({
  ...LogPosition.fields,
  source: Schema.String,
  ids: Schema.Array(Schema.String),
});
interface Shipment extends Schema.Schema.Type<typeof Shipment> {}

/** A shipment posted to Analytics whose events are not all confirmed stored yet. */
const Pending = Schema.Struct({
  ...Shipment.fields,
  /** The Analytics launch the latest post went to. */
  launch: Schema.String,
  /** When the latest post ends at the latest, by its timeout. */
  postEndsAt: Schema.Finite,
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
  /** When this session started serving the target. */
  readonly resumedAt: number;
}

/** `unsettled` posts may have reached Analytics without an answer; `failed` ones were not queued. */
type Delivery = "sent" | "unsettled" | "failed" | "refused" | "rejected";

/** Whether a settle already warned of failed posts and of rejected bodies. */
interface Warned {
  readonly post: Ref.Ref<boolean>;
  readonly rejection: Ref.Ref<boolean>;
}

const batchEvents = 256;
export const batchBytes = 1024 * 1024;
/** How long after a post ended its events may still be stored by a launch that stopped. */
export const flushWindowMillis = 5_000;
/** How often stored ids are checked while a body is unconfirmed. */
export const pollMillis = 250;
/** The first delay of the shared retry backoff. */
export const retryMillis = 500;
/** The longest a post may take, so a pending body knows when its post ended at the latest. */
export const postTimeoutMillis = 5_000;
/**
 * How long a live launch may take to store what it accepted: past it, the serving launch's
 * unstored events count as dropped, and a previous owner's launch has stopped or drained.
 */
export const stuckMillis = 60_000;
/** More sessions than can share one target. */
const targetUsers = 2 ** 30;
const envelopeBytes = '{"batch":[]}'.length;
const cursorFile = "cursor.json";
const encoder = new TextEncoder();
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeEffect(Schema.fromJsonString(Cursor));
const retrySchedule = Schedule.exponential(Duration.millis(retryMillis), 2).pipe(
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

/** Splits ids into two halves, the first one longer by at most one. */
const halves = (ids: ReadonlyArray<string>): Array<ReadonlyArray<string>> => {
  const middle = Math.ceil(ids.length / 2);
  return [ids.slice(0, middle), ids.slice(middle)].filter((half) => half.length > 0);
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

/** Connection failures that mean a request never reached Analytics. */
const unsentCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
]);

/** A post that timed out or broke after it was sent, so Analytics may have queued its events. */
const mayHaveQueued = (error: unknown): boolean => {
  if (Cause.isTimeoutError(error)) return true;
  if (!(error instanceof HttpClientError.HttpClientError)) return false;
  const { reason } = error;
  if (reason._tag === "TransportError") return !unsentCodes.has(errorCode(reason.cause) ?? "");
  return reason._tag === "DecodeError" || reason._tag === "EmptyBodyError";
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
  const targetScope = yield* Ref.make<
    { readonly scope: Scope.Closeable; readonly users: Semaphore.Semaphore } | undefined
  >(undefined);
  const epochs = yield* Ref.make(0);
  const rebinding = yield* Semaphore.make(1);
  const run = yield* crypto.randomUUIDv4;
  const launchPrefix = `${run}:`;
  const launchOf = (candidate: Candidate) =>
    `${launchPrefix}${candidate.instance.id}:${candidate.launchId ?? "unknown"}`;
  let postSequence = 0;

  const rebind = Effect.gen(function* () {
    const members = new Set((yield* options.composition).members.map(({ id }) => id));
    const serving = [...(yield* Ref.get(candidates)).values()].find(
      (candidate) => candidate.serving && members.has(candidate.instance.id),
    );
    const previous = yield* SubscriptionRef.get(target);
    if (
      serving?.instance === previous?.instance &&
      (serving === undefined || launchOf(serving) === previous?.launch)
    )
      return;
    const epoch = yield* Ref.updateAndGet(epochs, (value) => value + 1);
    const scope = serving === undefined ? undefined : yield* Scope.fork(forwarderScope);
    const next =
      serving === undefined || scope === undefined
        ? undefined
        : {
            instance: serving.instance,
            epoch,
            launch: launchOf(serving),
            stored: yield* options.storedEvents(serving.instance).pipe(Scope.provide(scope)),
            users: yield* Semaphore.make(targetUsers),
            storedPost: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
          };
    const retired = yield* Ref.getAndSet(
      targetScope,
      scope === undefined || next === undefined ? undefined : { scope, users: next.users },
    );
    yield* SubscriptionRef.set(target, next);
    yield* next === undefined
      ? Effect.logInfo("Log shipping paused until Analytics is running and healthy")
      : Effect.logInfo(
          `Log shipping targets Analytics instance ${next.instance.id}, launch ${serving?.launchId ?? "unknown"}`,
        );
    if (retired !== undefined)
      yield* Effect.forkIn(
        retired.users.take(targetUsers).pipe(Effect.andThen(Scope.close(retired.scope, Exit.void))),
        forwarderScope,
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
            launchId: observation.launchId,
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
    deadline: number,
  ) {
    yield* requireCurrent(current);
    const creation = yield* current.instance.creation;
    const apiKey = creation.service === "analytics" ? creation.config.apiKey : undefined;
    if (apiKey === undefined) return yield* new StaleTarget();
    const endpoint = yield* current.instance.endpoint("http");
    const remaining = deadline - (yield* Clock.currentTimeMillis);
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
        Effect.timeout(Duration.millis(Math.max(remaining, 0))),
      );
  });

  /** Posts one body of `lines` events once, ending by `deadline`, and classifies the answer. */
  const deliver = (
    session: Session,
    source: string,
    body: Body<{ readonly event: ShippedEvent }>,
    deadline: number,
    warned: Warned,
  ) =>
    post(session.current, source, body.body, deadline).pipe(
      session.posting.withPermits(1),
      Effect.as<Delivery>("sent"),
      Effect.catchIf(isTargetRejection, (error) =>
        Effect.logWarning(
          `Analytics refused ${source} logs of ${session.instanceId}; pausing until it changes`,
          error,
        ).pipe(Effect.as<Delivery>("refused")),
      ),
      Effect.catch((error) => {
        if (error._tag === "StaleTarget") return Effect.fail(error);
        if (isBodyRejection(error))
          return warnOnce(
            warned.rejection,
            `Analytics rejected a body of ${body.items.length} ${source} lines of ${session.instanceId}`,
            error,
          ).pipe(Effect.as<Delivery>("rejected"));
        if (!mayHaveQueued(error))
          return warnOnce(
            warned.post,
            `Posting ${source} logs of ${session.instanceId} failed; retrying`,
            error,
          ).pipe(Effect.as<Delivery>("failed"));
        return warnOnce(
          warned.post,
          `Posting ${source} logs of ${session.instanceId} got no answer; waiting until Analytics stores them`,
          error,
        ).pipe(Effect.as<Delivery>("unsettled"));
      }),
    );

  /**
   * Advances past a shipment once Analytics stored all its events, posting only missing events.
   * A post that may have been queued is posted again only once the launch that took it can no
   * longer store it: after `flushWindowMillis` for an ended launch of this owner, after
   * `stuckMillis` for a previous owner's launch. Events the current launch leaves unstored for
   * `stuckMillis` are posted again in halves; one that still is not stored on its own is skipped
   * once a later post to the launch was stored, and kept pending otherwise. A refused
   * target clears the pending body and pauses; a rejected body is skipped.
   */
  const settle = Effect.fn("LogForwarder.settle")(function* (
    session: Session,
    shipment: Shipment,
    events: ReadonlyMap<string, ShippedEvent>,
    posted: Pending | undefined,
  ) {
    const { source } = shipment;
    yield* Effect.annotateCurrentSpan({
      source,
      instance_id: session.instanceId,
      launch: session.current.launch,
      event_count: shipment.ids.length,
    });
    const warned: Warned = { post: yield* Ref.make(false), rejection: yield* Ref.make(false) };
    const counts = { checks: 0, checkAttempts: 0, posts: 0, deleted: 0, stuck: 0, skipped: 0 };
    let remaining = shipment.ids;
    /** The sequence number of the latest post, and the ids it carried. */
    let lastPost = 0;
    let lastPosted: ReadonlySet<string> = new Set();
    let latest: { readonly queuedIn: string | undefined; readonly endedAt: number } | undefined =
      posted === undefined ? undefined : { queuedIn: posted.launch, endedAt: posted.postEndsAt };

    /** Only the first attempt of the first check is traced; the rest are counted on this span. */
    const storedIds = (ids: ReadonlyArray<string>) =>
      Effect.suspend(() => {
        const check = session.current.stored.storedIds(source, ids);
        return counts.checkAttempts++ === 0 ? check : check.pipe(Effect.withTracerEnabled(false));
      }).pipe(Effect.retry(retrySchedule));

    /** Posts `initial` until Analytics stored it, and returns the ids left unstored for `stuckMillis`. */
    const deliverAll = Effect.fnUntraced(function* (initial: ReadonlyArray<string>) {
      let wanted = initial;
      delivering: while (true) {
        counts.checks++;
        const stored = yield* storedIds(wanted);
        if (lastPost > 0 && [...lastPosted].some((id) => stored.has(id)))
          yield* Ref.update(session.current.storedPost, (posts) =>
            new Map(posts).set(source, Math.max(posts.get(source) ?? 0, lastPost)),
          );
        const missing = wanted.filter((id) => !stored.has(id));
        if (missing.length === 0) return [];
        const now = yield* Clock.currentTimeMillis;
        if (latest !== undefined) {
          const { queuedIn, endedAt } = latest;
          if (queuedIn === session.current.launch) {
            // Only time this session served the launch counts, not time Analytics was unhealthy.
            if (now >= Math.max(endedAt, session.resumedAt) + stuckMillis) return missing;
            yield* Effect.sleep(pollMillis);
            continue;
          }
          // This owner starts a launch only after the previous one exited; another owner's launch
          // may still be draining its queue.
          const drained =
            queuedIn === undefined || queuedIn.startsWith(launchPrefix)
              ? flushWindowMillis
              : stuckMillis;
          if (now < endedAt + drained) {
            yield* Effect.sleep(pollMillis);
            continue;
          }
        }
        const deleted = new Set(missing.filter((id) => !events.has(id)));
        if (deleted.size > 0) {
          yield* Effect.logWarning(
            `Logs of ${session.service} instance ${session.instanceId} were deleted before Analytics stored them; skipping ${deleted.size} lines`,
          );
          counts.deleted += deleted.size;
          wanted = wanted.filter((id) => !deleted.has(id));
          remaining = remaining.filter((id) => !deleted.has(id));
        }
        const resend = missing.flatMap((id) => {
          const event = events.get(id);
          return event === undefined ? [] : [{ event }];
        });
        if (resend.length === 0) return [];
        let queuedIn: string | undefined;
        for (const body of bodies(resend)) {
          const deadline = (yield* Clock.currentTimeMillis) + postTimeoutMillis;
          yield* persist(session, {
            confirmed: (yield* Ref.get(session.progress)).confirmed,
            pending: {
              ...positionOf(shipment),
              source,
              ids: remaining,
              launch: session.current.launch,
              postEndsAt: deadline,
            },
          });
          // A slow cursor write leaves no time to post by the saved deadline.
          if ((yield* Clock.currentTimeMillis) >= deadline) continue delivering;
          counts.posts++;
          lastPost = ++postSequence;
          lastPosted = new Set(body.items.map(({ event }) => event.id));
          const delivery = yield* deliver(session, source, body, deadline, warned);
          if (delivery === "refused") {
            yield* persist(session, {
              confirmed: (yield* Ref.get(session.progress)).confirmed,
              pending: undefined,
            });
            return yield* new StaleTarget();
          }
          if (delivery === "rejected") return "rejected";
          if (delivery !== "failed") queuedIn = session.current.launch;
        }
        latest = { queuedIn, endedAt: yield* Clock.currentTimeMillis };
      }
    });

    /**
     * Posts the ids Analytics left unstored in halves until each unstored one was posted alone.
     * A lone unstored id is skipped only once a later post to this launch got stored, which shows
     * Analytics is storing; otherwise it is posted alone again in the next round.
     */
    const isolate = Effect.fnUntraced(function* (initial: ReadonlyArray<string>) {
      const idleWarned = yield* Ref.make(false);
      let groups = halves(initial);
      while (groups.length > 0) {
        const suspects: Array<{ readonly id: string; readonly post: number }> = [];
        const skipped = new Set<string>();
        let rejected = 0;
        for (let group = groups.shift(); group !== undefined; group = groups.shift()) {
          latest = undefined;
          const left = yield* deliverAll(group);
          const [lone] = group;
          if (left === "rejected") {
            if (group.length === 1 && lone !== undefined) {
              skipped.add(lone);
              rejected++;
            } else groups.unshift(...halves(group));
          } else if (left.length > 0) {
            if (group.length === 1 && lone !== undefined)
              suspects.push({ id: lone, post: lastPost });
            else groups.unshift(...halves(left));
          }
        }
        const proof = (yield* Ref.get(session.current.storedPost)).get(source) ?? 0;
        for (const suspect of suspects) if (proof > suspect.post) skipped.add(suspect.id);
        if (skipped.size > 0) {
          yield* Effect.logWarning(
            `Analytics did not store ${skipped.size} ${source} lines of ${session.instanceId} posted on their own (${rejected} rejected, ${skipped.size - rejected} unstored while it stored later posts); skipping them`,
          );
          remaining = remaining.filter((id) => !skipped.has(id));
          counts.skipped += skipped.size;
        }
        groups = suspects.flatMap(({ id }) => (skipped.has(id) ? [] : [[id]]));
        if (groups.length > 0)
          yield* Ref.getAndSet(idleWarned, true).pipe(
            Effect.flatMap((already) =>
              already
                ? Effect.void
                : Effect.logWarning(
                    `Analytics stored none of ${groups.length} ${source} lines of ${session.instanceId} posted on their own; waiting until it stores them`,
                  ),
            ),
          );
      }
    });

    yield* Effect.gen(function* () {
      const stuck = yield* deliverAll(shipment.ids);
      if (stuck === "rejected") {
        yield* Effect.logWarning(
          `Skipping ${remaining.length} ${source} lines of ${session.instanceId} that Analytics rejected`,
        );
        counts.skipped += remaining.length;
      } else if (stuck.length > 0) {
        counts.stuck = stuck.length;
        yield* Effect.logWarning(
          `Analytics has not stored ${stuck.length} ${source} lines of ${session.instanceId} it accepted; posting them in halves`,
        );
        yield* isolate(stuck);
      }
      yield* persist(session, { confirmed: positionOf(shipment), pending: undefined });
    }).pipe(
      // Counted on every exit, so a stuck or retargeted settle still shows its progress.
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.annotateCurrentSpan({
            check_count: counts.checks,
            check_attempt_count: counts.checkAttempts,
            post_count: counts.posts,
            deleted_count: counts.deleted,
            stuck_count: counts.stuck,
            skipped_count: counts.skipped,
          }),
        ),
      ),
    );
  });

  /** Rebuilds a pending body from its retained records and settles it. */
  const reconcile = Effect.fn("LogForwarder.reconcile")(function* (
    session: Session,
    confirmed: LogPosition | undefined,
    pending: Pending,
  ) {
    yield* Effect.annotateCurrentSpan({
      instance_id: session.instanceId,
      source: pending.source,
      pending_count: pending.ids.length,
    });
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
    yield* Effect.annotateCurrentSpan({ recovered_count: events.size });
    yield* settle(session, pending, events, pending);
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
        const shipping: Session = {
          instanceId,
          service,
          directory,
          current,
          progress,
          posting,
          resumedAt: yield* Clock.currentTimeMillis,
        };
        if (saved.pending !== undefined) yield* reconcile(shipping, saved.confirmed, saved.pending);
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
                yield* settle(
                  shipping,
                  { ...last.position, source, ids: items.map(({ event }) => event.id) },
                  new Map(items.map(({ event }) => [event.id, event])),
                  undefined,
                );
                yield* Ref.set(failing, false);
              }
            }),
          ),
        );
      }),
    ).pipe(current.users.withPermits(1));

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
        const posting = yield* Semaphore.make(1);
        // A stopped or refused target pauses shipping until it changes; a failed log read resumes
        // from the cursor after a backoff.
        const detached = yield* session(id, service, current, failing, posting).pipe(
          Effect.tapError((error) =>
            error._tag === "StaleTarget"
              ? Effect.void
              : warnOnce(failing, `Reading ${id} logs to ship failed; retrying`, error),
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
