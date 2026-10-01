import { DateTime, Effect, PubSub, Stream } from "effect";
import type { HttpAccess, HttpAccessSink } from "../HttpProxy.ts";
import { launchOutputPublisher, type LaunchOutput } from "../runtime/Session.ts";
import type { CatalogLogs } from "../services/Recipe.ts";

/** The log stream of the shared API listener's access records, one per owner and stack. */
export const gatewayLog = { service: "gateway", instanceId: "gateway" } as const;

/** Bounds records not yet persisted; the oldest are dropped and reported as lost. */
const bufferedRecords = 4096;

const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const two = (value: number) => String(value).padStart(2, "0");

/** Formats epoch milliseconds as nginx's `$time_local` in UTC. */
const nginxTime = (millis: number) => {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(millis));
  return `${two(parts.day)}/${monthNames[parts.month - 1]}/${parts.year}:${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)} +0000`;
};

/** Escapes quotes, backslashes and control characters like nginx's default log escaping. */
const escape = (value: string) =>
  value.replace(
    // oxlint-disable-next-line no-control-regex -- control characters are what this escapes.
    /["\\\u0000-\u001f\u007f]/gu,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

/** Formats an access record as an nginx combined log line followed by its duration. */
export const formatAccess = (access: HttpAccess) =>
  `${access.client} - - [${nginxTime(access.time)}] "${escape(`${access.method} ${access.target} ${access.protocol}`)}" ${access.status} ${access.bytes ?? "-"} "${escape(access.referer ?? "-")}" "${escape(access.userAgent ?? "-")}" ${access.durationMillis}ms`;

const encoder = new TextEncoder();

/** The gateway stream's output, its access sink, and an observation of one launch per owner run. */
export interface GatewayLog {
  readonly logs: CatalogLogs;
  readonly record: HttpAccessSink;
  readonly observation: Stream.Stream<{ readonly launchId: number }>;
}

export const make = Effect.gen(function* () {
  const output = yield* PubSub.sliding<LaunchOutput>(bufferedRecords);
  const publish = yield* (yield* launchOutputPublisher(output, 1)).part;
  return {
    logs: PubSub.subscribe(output),
    record: (access) => publish("stdout", encoder.encode(`${formatAccess(access)}\n`)),
    observation: Stream.make({ launchId: 1 }).pipe(Stream.concat(Stream.never)),
  } satisfies GatewayLog;
});
