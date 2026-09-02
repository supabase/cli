import { Effect, Option, Ref, Schedule } from "effect";
import { Output } from "../../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../../shared/cli/success-trailer.ts";
import {
  legacyWorkerNotDeployed,
  legacyWorkersPushCommand,
  legacyWorkersStatusCommand,
} from "../workers.commands.ts";
import { legacyAqua } from "../../../../shared/legacy-colors.ts";
import { legacyEmitWorkersPayload, legacyRejectWorkersEnvOutput } from "../workers.output.ts";
import {
  legacyRenderWorkerLogLine,
  legacyWorkerLogLevel,
  legacyWorkerLogText,
} from "../workers-logs.format.ts";
import { ProcessControl } from "../../../../../shared/runtime/process-control.service.ts";
import { LegacyWorkersFollowNotSupportedError } from "../workers.errors.ts";
import { LegacyPlatformApi } from "../../../../auth/legacy-platform-api.service.ts";
import {
  fetchWorkerLogs,
  type WorkerLogEntry,
} from "../../../../../shared/workers/worker-logs-api.ts";
import {
  ALL_WORKER_LOG_STREAMS,
  followWindow,
  logWindow,
  WORKER_LOG_POLL_SECONDS,
  WORKER_LOG_STREAMS,
} from "../../../../../shared/workers/worker-logs.sql.ts";
import { getWorker } from "../../../../../shared/workers/workers-api.ts";
import {
  WorkerLogsQueryFailedError,
  WorkerLogsRateLimitedError,
  WorkersApiNetworkError,
  WorkersApiUnexpectedStatusError,
} from "../../../../../shared/workers/workers.errors.ts";
import { legacyValidateWorkerName } from "../workers.shared.ts";
import {
  legacyWorkersMachineOutputRequested,
  legacyWorkersRenderFormat,
} from "../workers.output.ts";
import { legacyWorkersRun } from "../workers.run.ts";
import type { LegacyWorkersLogsFlags } from "./logs.command.ts";

/**
 * `supabase experimental workers logs <name>` — what the worker has actually been doing.
 *
 * `status` reports the deployment; this reports the runtime. Between them they
 * cover the two questions a deployed worker raises, and neither answers the
 * other's.
 *
 * Unlike the rest of the family this does not talk to `/v2/.../workers` — there is
 * no worker-scoped log route — but to the project's unified logs stream. See
 * `worker-logs.sql.ts` for the query and why it filters on `log_attributes`
 * rather than the `source` column.
 */

/**
 * How many printed ids the follow loop remembers.
 *
 * Only lines inside the cursor's grace window can still be re-offered by a later
 * poll, so a bound well above one window's worth cannot cause a repeat while
 * keeping the set from growing for the lifetime of a long tail.
 */
const SEEN_ID_LIMIT = 5000;

/** Rows per poll request. Independent of `--tail`, which bounds history only. */
const FOLLOW_PAGE_SIZE = 1000;

/** Requests one poll may spend draining a burst, against a 10/minute budget. */
const FOLLOW_MAX_PAGES = 5;

/**
 * How long one poll may keep failing before the tail gives up.
 *
 * Bounded by elapsed time rather than attempts, and spaced, so a 429 or a
 * momentary blip is ridden out without spending the rate limit on retries. Same
 * reasoning as `awaitWorkerBuild`'s read retry.
 */
const FOLLOW_READ_RETRY = Schedule.spaced("5 seconds").pipe(
  Schedule.upTo({ duration: "1 minute" }),
);

/**
 * Which poll failures are worth another request.
 *
 * Server-side statuses, plus 408 and 429 — the server asking for a retry.
 * Definitive answers (401, 402, 404) surface immediately rather than burning a
 * minute and most of the rate limit first. A decode failure carries the
 * response's own status, so a malformed 200 body reads as terminal.
 */
function isRetryableFollowFailure(error: unknown): boolean {
  if (error instanceof WorkersApiUnexpectedStatusError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return (
    error instanceof WorkerLogsRateLimitedError ||
    error instanceof WorkersApiNetworkError ||
    // The endpoint reports a rejected or timed-out query this way, and its own
    // suggestion is to retry shortly.
    error instanceof WorkerLogsQueryFailedError
  );
}

/** Where the tail has got to: the newest line printed, and the ids printed. */
interface FollowCursor {
  readonly newestMs: number;
  readonly seen: ReadonlySet<string>;
}

/**
 * Move the cursor past `fresh`. The timestamp and the id set are only correct
 * together: advancing one without the other replays the overlap or loses it.
 *
 * The id set is bounded — only ids inside the grace window can be re-offered,
 * so forgetting the oldest cannot resurrect them.
 */
function advanceCursor(cursor: FollowCursor, fresh: ReadonlyArray<WorkerLogEntry>): FollowCursor {
  const seen = new Set(cursor.seen);
  for (const row of fresh) {
    seen.add(row.id);
  }
  return {
    newestMs: fresh.reduce((newest, row) => Math.max(newest, row.timestampMs), cursor.newestMs),
    seen: seen.size <= SEEN_ID_LIMIT ? seen : new Set([...seen].slice(seen.size - SEEN_ID_LIMIT)),
  };
}

/**
 * Every row since `cursorMs`, across as many requests as it takes.
 *
 * The query orders newest-first, so one request answers with only the newest
 * page. Walk `end` backwards while pages come back full; a short page means the
 * window is drained. Bounded by the endpoint's ten-per-minute allowance — rows
 * past the bound are not lost, since the cursor only advances over what was
 * emitted.
 */
const drainSince = Effect.fnUntraced(function* (input: {
  readonly api: LegacyPlatformApi["Service"];
  readonly projectRef: string;
  readonly name: string;
  readonly streams: ReadonlyArray<string>;
  readonly cursorMs: number;
}) {
  const collected: Array<WorkerLogEntry> = [];
  let end = new Date();
  for (let page = 0; page < FOLLOW_MAX_PAGES; page += 1) {
    const rows = yield* fetchWorkerLogs(input.api, input.projectRef, {
      name: input.name,
      streams: input.streams,
      tail: FOLLOW_PAGE_SIZE,
      window: followWindow(end, input.cursorMs),
    });
    collected.push(...rows);
    if (rows.length < FOLLOW_PAGE_SIZE) {
      break;
    }
    // Rows arrive oldest-first, so the next page ends where this one began. A
    // full page sharing one timestamp cannot narrow the window: stop rather than
    // re-request it, and let the next poll's grace window cover the remainder.
    const nextEnd = new Date(rows[0]!.timestampMs);
    if (nextEnd.getTime() >= end.getTime()) {
      break;
    }
    end = nextEnd;
  }
  return collected;
});

/**
 * Test seams for the follow loop.
 *
 * Both schedules are parameters for the same reason `awaitWorkerBuild`'s are: the
 * real ones are spaced in seconds, and a test exercising the cursor, the dedupe,
 * or the retry path should not wait on a wall clock to do it.
 */
export interface LegacyWorkersLogsOptions {
  readonly pollSchedule?: Schedule.Schedule<unknown>;
  readonly retrySchedule?: Schedule.Schedule<unknown>;
}

/** The machine-format row for one line. */
function toPayloadEntry(entry: WorkerLogEntry) {
  const level = legacyWorkerLogLevel(entry);
  return {
    id: entry.id,
    // Both forms: the ISO string is what a human or `jq` wants to read, the raw
    // epoch value is what a script sorts or diffs on without reparsing.
    timestamp: new Date(entry.timestampMs).toISOString(),
    timestamp_ms: entry.timestampMs,
    stream: entry.stream,
    message: entry.message,
    ...(level === undefined ? {} : { level }),
    attributes: entry.attributes,
  };
}

export const legacyWorkersLogs = Effect.fn("legacy.experimental.workers.logs")(function* (
  flags: LegacyWorkersLogsFlags,
  options: LegacyWorkersLogsOptions = {},
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const processControl = yield* ProcessControl;

  yield* legacyWorkersRun(flags.projectRef, ({ projectRef, refSuffix }) =>
    Effect.gen(function* () {
      const name = yield* legacyValidateWorkerName(flags.name);

      // Up front, like the rest of the family: this payload always carries a `logs`
      // array, so `-o env` can never encode it, and finding that out at emit time
      // means failing after the query has already been paid for.
      yield* legacyRejectWorkersEnvOutput();

      // Resolved once, before anything branches: `-o` outranks `--output-format`,
      // so `output.format` on its own is not what this run renders in.
      const renderFormat = yield* legacyWorkersRenderFormat();

      // Also up front: a tail has no single terminal payload, so the bounded
      // machine formats cannot express it. `stream-json` can, and is allowed.
      if (flags.follow) {
        const machineOutput = yield* legacyWorkersMachineOutputRequested();
        if (machineOutput || renderFormat === "json") {
          return yield* new LegacyWorkersFollowNotSupportedError({
            message:
              "--follow cannot be combined with a single-payload output format. " +
              "Use --output-format stream-json to stream, or drop --follow.",
          });
        }
      }

      const pollSchedule =
        options.pollSchedule ?? Schedule.spaced(`${WORKER_LOG_POLL_SECONDS} seconds`);
      const readRetrySchedule = options.retrySchedule ?? FOLLOW_READ_RETRY;

      // The stream tag only earns its width when streams are actually mixed; with
      // `--kind` every line would carry the same one.
      const showStream = Option.isNone(flags.kind);

      /**
       * Write a batch of lines out, in whichever form the format calls for.
       *
       * `stream-json` emits the existing `log-entry` event per line rather than one
       * terminal `result`: a tail has no terminal element, and that variant already
       * carries the field set this needs. `stream` is derived from the level so a
       * consumer can split diagnostics from ordinary output the way it would for a
       * real process; `source` distinguishes the backlog from what arrived after.
       */
      const emitLines = (
        batch: ReadonlyArray<WorkerLogEntry>,
        origin: "history" | "live" = "history",
      ) =>
        Effect.gen(function* () {
          if (batch.length === 0) {
            return;
          }
          if (renderFormat === "stream-json") {
            for (const entry of batch) {
              const level = legacyWorkerLogLevel(entry);
              yield* output.event({
                type: "log-entry",
                timestamp: new Date(entry.timestampMs).toISOString(),
                service: name,
                stream: level === "error" || level === "warn" ? "stderr" : "stdout",
                // The composed sentence, the same one text mode renders: a
                // request line's status and duration and a build's reason live
                // in `log_attributes`, and `log-entry` has no field to carry
                // them separately.
                line: legacyWorkerLogText(entry),
                source: origin,
              });
            }
            return;
          }
          yield* output.raw(
            `${batch.map((entry) => legacyRenderWorkerLogLine(entry, { showStream })).join("\n")}\n`,
          );
        });

      const streams = Option.isSome(flags.kind)
        ? [WORKER_LOG_STREAMS[flags.kind.value]]
        : ALL_WORKER_LOG_STREAMS;

      // Before any request, so a slow one cannot widen `followFloorMs` below.
      const startedAtMs = Date.now();

      // `--tail 0` is "no history". On its own that is a no-op, but it is the shape
      // `--follow` will want, and issuing a `limit 0` query would be a 400.
      const entries =
        flags.tail === 0
          ? []
          : yield* Effect.gen(function* () {
              const fetching = yield* output.task("Fetching logs...");
              const rows = yield* fetchWorkerLogs(api, projectRef, {
                name,
                streams,
                tail: flags.tail,
                window: logWindow(new Date()),
              }).pipe(Effect.tapError(() => fetching.fail()));
              yield* fetching.clear();
              return rows;
            });

      // Zero rows is two situations wearing one face: not deployed, or deployed
      // and quiet. Worth one extra request to tell them apart. `--tail 0` queried
      // nothing, so it only needs the check when it is going on to tail.
      if (entries.length === 0 && (flags.tail > 0 || flags.follow)) {
        // Its own task: `--tail 0` has no "Fetching logs..." to inherit.
        const checking = yield* output.task("Checking worker...");
        const deployed = yield* getWorker(api, projectRef, name).pipe(
          Effect.tapError(() => checking.fail()),
        );
        yield* checking.clear();
        if (Option.isNone(deployed)) {
          return yield* Effect.fail(
            legacyWorkerNotDeployed({
              name,
              projectRef,
              suggestion: `Deploy it with \`${legacyWorkersPushCommand(name, refSuffix)}\`.`,
            }),
          );
        }
      }

      const payload = {
        worker_name: name,
        project_ref: projectRef,
        ...(Option.isSome(flags.kind) ? { kind: flags.kind.value } : {}),
        logs: entries.map(toPayloadEntry),
      };

      // Only for a bounded read: a tail has no terminal payload to put here, and
      // emits a `log-entry` event per line through `emitLines` instead.
      if (!flags.follow && (yield* legacyEmitWorkersPayload(payload))) {
        return;
      }

      if (entries.length === 0 && !flags.follow) {
        // Deployed (the check above would have failed otherwise) and silent.
        yield* output.raw(`No logs for "${name}" in the last 24 hours.\n`);
        yield* emitSuccessTrailer(
          `Check it is running with ${legacyAqua(legacyWorkersStatusCommand(name, refSuffix))}.\n`,
        );
        return;
      }

      // Oldest first: the query orders newest-first so `limit` means "most recent",
      // but a reader scrolls forwards through time, and a stack trace only makes
      // sense in the order it was printed.
      yield* emitLines(entries);

      // A tail with nothing to show yet would otherwise look like a hang. On stderr,
      // so it never lands in piped output.
      if (flags.follow && entries.length === 0 && renderFormat === "text") {
        yield* output.raw(`Waiting for new logs from "${name}". Press Ctrl+C to stop.\n`, "stderr");
      }

      if (!flags.follow) {
        return;
      }

      // --- follow ---------------------------------------------------------------
      // Inside the generator, not captured while the Effect was built: an Effect
      // may run more than once, and shared cursor state would drop lines.
      const cursorRef = yield* Ref.make<FollowCursor>({
        newestMs: entries.at(-1)?.timestampMs ?? Date.now(),
        seen: new Set(entries.map((entry) => entry.id)),
      });

      // `followWindow` reaches a grace period behind the cursor so a late relay
      // is still caught — which for `--tail 0` would reopen the history it was
      // told to skip. Keep the wide window; filter on when the line was written.
      const followFloorMs = flags.tail === 0 ? startedAtMs : Number.NEGATIVE_INFINITY;

      const pollOnce = Effect.gen(function* () {
        const cursor = yield* Ref.get(cursorRef);
        const rows = yield* drainSince({
          api,
          projectRef,
          name,
          streams,
          cursorMs: cursor.newestMs,
        });

        // Windows always overlap — the server rounds them to the minute and the
        // cursor deliberately lags — so the dedupe is what makes the overlap
        // invisible rather than a source of repeats. Pages walk backwards, so
        // the concatenation is not in order until this sorts it.
        const fresh = rows
          .filter((row) => !cursor.seen.has(row.id) && row.timestampMs >= followFloorMs)
          .sort((left, right) => left.timestampMs - right.timestampMs);
        if (fresh.length === 0) {
          return;
        }

        yield* emitLines(fresh, "live");
        yield* Ref.set(cursorRef, advanceCursor(cursor, fresh));
      });

      // A blip should not end a tail someone is watching. See
      // `isRetryableFollowFailure` for what does not get a second attempt.
      const poll = pollOnce.pipe(
        Effect.retry({ schedule: readRetrySchedule, while: isRetryableFollowFailure }),
      );

      // `repeat` runs the body first, so the opening poll is immediate — it
      // catches whatever landed while the history query was in flight. ~7
      // requests in the worst 60-second window, against a limit of 10.
      yield* Effect.raceFirst(
        poll.pipe(Effect.repeat({ schedule: pollSchedule })),
        // `setExitCode`, not `exit`: `exit` calls `process.exit` synchronously,
        // tearing the runtime down before this command's finalizers run. Record
        // the code and let the race complete; `runCli` exits with it.
        processControl
          .awaitSignal()
          .pipe(
            Effect.flatMap((signal) => processControl.setExitCode(signal === "SIGINT" ? 130 : 0)),
          ),
      );
    }),
  );
});
