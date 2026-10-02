import { DateTime, Deferred, Effect, PubSub, Ref, Semaphore, Stream } from "effect";
import type { HttpAccess, HttpAccessSink } from "../HttpProxy.ts";
import {
  launchOutputPublisher,
  type LaunchOutput,
  type PublishOutput,
} from "../runtime/Session.ts";
import type { CatalogLogs } from "../services/Recipe.ts";
import { monthNames } from "./LogflareEvents.ts";

/** The log stream of the shared API listener's access records, one per owner and stack. */
export const gatewayLog = { service: "gateway", instanceId: "gateway" } as const;

/** Bounds records not yet persisted; the oldest are dropped and reported as lost. */
const bufferedRecords = 4096;

const two = (value: number) => String(value).padStart(2, "0");

/** Formats epoch milliseconds as nginx's `$time_local` in UTC, with milliseconds after the seconds. */
const nginxTime = (millis: number) => {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(millis));
  return `${two(parts.day)}/${monthNames[parts.month - 1]}/${parts.year}:${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)}.${String(parts.millisecond).padStart(3, "0")} +0000`;
};

/** Escapes quotes, backslashes and control characters like nginx's default log escaping. */
const escapeLogValue = (value: string) =>
  value.replace(
    // oxlint-disable-next-line no-control-regex -- control characters are what this escapes.
    /["\\\u0000-\u001f\u007f]/gu,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

/** Formats an access record as an nginx combined log line followed by its duration. */
export const formatAccess = (access: HttpAccess) =>
  `${access.client} - - [${nginxTime(access.time)}] "${escapeLogValue(`${access.method} ${access.target} ${access.protocol}`)}" ${access.status} ${access.bytes ?? "-"} "${escapeLogValue(access.referer ?? "-")}" "${escapeLogValue(access.userAgent ?? "-")}" ${access.durationMillis}ms`;

const encoder = new TextEncoder();

/** The gateway stream's output, its access sink, and an observation of one launch per owner run. */
export interface GatewayLog {
  readonly logs: CatalogLogs;
  /** Records an access once the owner run's launch began; earlier ones have no reader yet. */
  readonly record: HttpAccessSink;
  readonly observation: Stream.Stream<{ readonly launchId: number }>;
  /** Begins this owner run's launch, numbered after the retained ones. */
  readonly begin: (launchId: number) => Effect.Effect<void>;
}

export const make = Effect.gen(function* () {
  const output = yield* PubSub.sliding<LaunchOutput>(bufferedRecords);
  const launch = yield* Deferred.make<number>();
  const publisher = yield* Ref.make<PublishOutput | undefined>(undefined);
  // Requests settle concurrently; publishing one at a time keeps sequence numbers in order.
  const publishing = yield* Semaphore.make(1);
  return {
    logs: PubSub.subscribe(output),
    record: (access) =>
      Ref.get(publisher).pipe(
        Effect.flatMap((publish) =>
          publish === undefined
            ? Effect.void
            : publish("stdout", encoder.encode(`${formatAccess(access)}\n`)),
        ),
        publishing.withPermits(1),
      ),
    observation: Stream.fromEffect(Deferred.await(launch)).pipe(
      Stream.map((launchId) => ({ launchId })),
      Stream.concat(Stream.never),
    ),
    begin: (launchId) =>
      launchOutputPublisher(output, launchId).pipe(
        Effect.flatMap(({ part }) => part),
        Effect.flatMap((publish) => Ref.set(publisher, publish)),
        Effect.andThen(Deferred.succeed(launch, launchId)),
        Effect.asVoid,
      ),
  } satisfies GatewayLog;
});
