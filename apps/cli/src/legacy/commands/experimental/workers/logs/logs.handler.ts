import { Effect, Option, Ref, Schedule } from "effect";
import { Output } from "../../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../../shared/cli/success-trailer.ts";
import { legacyAqua } from "../../../../shared/legacy-colors.ts";
import {
  legacyEmitWorkersMachineOutput,
  legacyRejectWorkersEnvOutput,
  legacyWorkersProjectRefSuffix,
} from "../workers.output.ts";
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
  WorkerNotDeployedError,
  WorkersApiNetworkError,
  WorkersApiUnexpectedStatusError,
} from "../../../../../shared/workers/workers.errors.ts";
import { LegacyProjectRefResolver } from "../../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyValidateWorkerName } from "../workers.shared.ts";
import {
  legacyWorkersMachineOutputRequested,
  legacyWorkersRenderFormat,
} from "../workers.output.ts";
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

/**
 * How many rows one poll asks for per request.
 *
 * Independent of `--tail`, which bounds only the history a run opens with.
 * Sharing them meant `--tail 1 --follow` polled with `limit 1`: the query orders
 * newest-first, so a burst came back as its newest row alone and the cursor then
 * advanced past the rest, dropping them for good. The default `--tail 100` had
 * the same hole above 100 rows in a polling interval.
 */
const FOLLOW_PAGE_SIZE = 1000;

/**
 * How many requests one poll may spend draining a burst.
 *
 * A bound rather than an open loop: the endpoint allows 10 requests a minute, so
 * an unbounded drain could spend a whole window's allowance on one poll.
 *
 * **Rows past the bound are dropped, not deferred.** The drain walks `end`
 * backwards, so the pages it did fetch are the *newest* ones; the cursor then
 * advances to the newest row printed, past the region it never reached. Only the
 * part of that region inside the next window's grace is picked up again. Nothing
 * here can fix that — `followWindow` moves the window's floor, not its ceiling,
 * so lowering the cursor just re-fetches the same newest pages and never walks
 * down to the gap. A burst above {@link FOLLOW_PAGE_SIZE} × this bound in one
 * poll interval therefore loses its middle, and says so on stderr.
 */
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
 * Which poll failures are worth spending another request on.
 *
 * A tail should ride out a 429 or a momentary blip, but 401, 402 and 404 answer
 * the same way every time. Retrying those held the error back for a minute and
 * spent most of the endpoint's ten-requests-per-minute allowance getting nowhere,
 * so the reader waited longer and then hit a rate limit on top of the real cause.
 *
 * Server-side statuses are retried and client-side ones are not, with the
 * exception of 408 and 429, which are the server asking for exactly that. A
 * decode failure carries the response's own status, so a malformed 200 body is
 * correctly read as terminal: it will not parse any better on a second attempt.
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
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const processControl = yield* ProcessControl;

  // Telemetry wraps the ref resolution as well: an unlinked non-interactive
  // checkout fails inside `resolve`, and by then the command has run. Only the
  // linked-project cache stays under the ref, since it has nothing to write
  // without one.
  yield* Effect.gen(function* () {
    const projectRef = yield* resolver.resolve(flags.projectRef);
    const refSuffix = legacyWorkersProjectRefSuffix(flags.projectRef);

    yield* Effect.gen(function* () {
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

      // Before any request, so a slow history query or deployed-worker check
      // cannot widen what `followFloorMs` below treats as "already there".
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

      // Nothing came back, which is two different situations wearing the same face:
      // a worker that is not deployed at all, and one that is deployed and quiet.
      // Only worth one extra request, and only in this branch.
      //
      // `--tail 0` makes no history query, so zero rows says nothing either way —
      // but a tail still has to know the worker exists, or a typo waits forever on
      // logs that can never arrive. A bounded `--tail 0` run prints nothing by
      // definition and is left alone.
      if (entries.length === 0 && (flags.tail > 0 || flags.follow)) {
        // Its own task: with `--tail 0` there is no "Fetching logs..." to inherit,
        // and clearing that one before this request left text mode silent across
        // a call that can take a moment.
        const checking = yield* output.task("Checking worker...");
        const deployed = yield* getWorker(api, projectRef, name).pipe(
          Effect.tapError(() => checking.fail()),
        );
        yield* checking.clear();
        if (Option.isNone(deployed)) {
          return yield* Effect.fail(
            new WorkerNotDeployedError({
              detail: `Nothing is deployed for "${name}" in project ${projectRef}.`,
              suggestion: `Deploy it with \`supabase experimental workers push ${name}${refSuffix}\`.`,
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

      // `-o` asks for a machine-readable stdout, so nothing human may be written to
      // it — `output.success` logs to stdout in text mode. Unreachable while
      // following, which refuses these formats up front.
      if (!flags.follow && (yield* legacyEmitWorkersMachineOutput(payload))) {
        return;
      }

      // One structured emission, in the structured branch only, and only for a
      // bounded read. A tail has no terminal payload to put here — it emits a
      // `log-entry` event per line through `emitLines` instead.
      if (!flags.follow && renderFormat !== "text") {
        yield* output.success("", payload);
        return;
      }

      if (entries.length === 0 && !flags.follow) {
        // Deployed (the check above would have failed otherwise) and silent.
        yield* output.raw(`No logs for "${name}" in the last 24 hours.\n`);
        yield* emitSuccessTrailer(
          `Check it is running with ${legacyAqua(`supabase experimental workers status ${name}${refSuffix}`)}.\n`,
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
      //
      // The cursor is the newest timestamp printed, and the set of ids already
      // printed. Both live inside this generator rather than being captured while
      // the Effect was built: an Effect is a reusable description and may run more
      // than once, and shared cursor state across runs would drop lines.
      const seenIds = yield* Ref.make(new Set(entries.map((entry) => entry.id)));
      // Same reason these live in the generator rather than the closure: an
      // Effect is a reusable description, and a notice already "shown" on a
      // previous run would stay silent on the next one.
      const skipNoticeShown = yield* Ref.make(false);
      const newestSeenMs = yield* Ref.make(
        entries.length === 0 ? Date.now() : entries[entries.length - 1]!.timestampMs,
      );

      // `--tail 0` asked for no history, and `followWindow` deliberately reaches
      // a grace period behind the cursor so a line relayed late is still caught.
      // Both are wanted, and together they let pre-invocation lines through — so
      // keep the wide window and filter on when the line was actually written.
      const followFloorMs = flags.tail === 0 ? startedAtMs : Number.NEGATIVE_INFINITY;

      const pollOnce = Effect.gen(function* () {
        const cursor = yield* Ref.get(newestSeenMs);

        // One request only ever answers with the newest page of its window, so a
        // burst bigger than a page needs several. Walk `end` backwards while
        // pages come back full; a short page means the window is drained.
        const collected: Array<WorkerLogEntry> = [];
        let end = new Date();
        // A short page is the only proof the window is empty below this point.
        // Both other exits — the page budget running out, and a full page too
        // narrow to walk past — leave rows unfetched underneath.
        let drained = false;
        for (let page = 0; page < FOLLOW_MAX_PAGES; page += 1) {
          const rows = yield* fetchWorkerLogs(api, projectRef, {
            name,
            streams,
            tail: FOLLOW_PAGE_SIZE,
            window: followWindow(end, cursor),
          });
          collected.push(...rows);
          if (rows.length < FOLLOW_PAGE_SIZE) {
            drained = true;
            break;
          }
          // Rows arrive oldest-first, so the next page ends where this one began.
          const nextEnd = new Date(rows[0]!.timestampMs);
          // A full page whose rows all share one timestamp cannot narrow the
          // window: re-requesting it would return the same page forever.
          if (nextEnd.getTime() >= end.getTime()) {
            break;
          }
          end = nextEnd;
        }

        // Once per run, not once per poll: a sustained burst would otherwise
        // repeat this every interval and bury the lines it is warning about.
        //
        // Emitted in **every** format, unlike the "Waiting for new logs" notice
        // above — same reasoning as `push`'s `reportUnattempted`. That one is
        // progress, which a machine consumer did not ask for; this one says the
        // stream it is reading has a hole in it, which it cannot infer from the
        // events themselves.
        if (!drained && !(yield* Ref.get(skipNoticeShown))) {
          yield* Ref.set(skipNoticeShown, true);
          yield* output.raw(
            `Skipped part of a burst larger than ${FOLLOW_MAX_PAGES * FOLLOW_PAGE_SIZE} lines: ` +
              `some lines older than the ones below were not printed. ` +
              `Narrow the stream with --kind, or read the full range in the dashboard.\n`,
            "stderr",
          );
        }

        // Windows always overlap - the server rounds them to the minute and the
        // cursor deliberately lags - so dedupe is what makes the overlap invisible
        // rather than a source of repeats.
        const printed = yield* Ref.get(seenIds);
        const fresh = collected
          .filter((row) => !printed.has(row.id) && row.timestampMs >= followFloorMs)
          // Each page is oldest-first but the pages themselves walk backwards, so
          // the concatenation is not ordered until this runs.
          .sort((left, right) => left.timestampMs - right.timestampMs);
        if (fresh.length === 0) {
          return;
        }

        yield* emitLines(fresh, "live");
        yield* Ref.update(seenIds, (previous) => {
          const next = new Set(previous);
          for (const row of fresh) {
            next.add(row.id);
          }
          // Bounded so a tail left running for hours does not grow it without
          // limit. Only ids inside the grace window can still be re-offered, so
          // forgetting the oldest cannot resurrect them.
          if (next.size <= SEEN_ID_LIMIT) {
            return next;
          }
          return new Set([...next].slice(next.size - SEEN_ID_LIMIT));
        });
        yield* Ref.set(
          newestSeenMs,
          fresh.reduce((newest, row) => Math.max(newest, row.timestampMs), cursor),
        );
      });

      // A 429 or a blip should not end a tail the user is watching; the schedule is
      // spaced in seconds, so retrying rides out a transient failure without
      // spending the rate limit. Anything definitive surfaces on the first
      // attempt — see `isRetryableFollowFailure`.
      const poll = pollOnce.pipe(
        Effect.retry({ schedule: readRetrySchedule, while: isRetryableFollowFailure }),
      );

      // `repeat` runs the body before applying the schedule, so the first poll is
      // immediate. That is wanted: it catches anything that landed while the history
      // query was in flight, and the rows it repeats are discarded by the id dedupe.
      //
      // Cost against the endpoint's limit of 10 requests per 60 seconds: a quiet
      // tail spends one request per poll, so 6 a minute, plus the opening history
      // query and the deployed-worker check. A poll draining a burst spends up to
      // `FOLLOW_MAX_PAGES`, so a sustained backlog can reach 30 a minute and will
      // be rate limited — `isRetryableFollowFailure` treats the 429 as transient
      // and the spaced retry rides it out, which throttles the tail rather than
      // ending it.
      yield* Effect.raceFirst(
        poll.pipe(Effect.repeat({ schedule: pollSchedule })),
        // `setExitCode`, not `exit`: the production `exit` calls `process.exit`
        // synchronously, which tears the runtime down from inside this race
        // branch — before the linked-project cache is written, before telemetry
        // is flushed, and before the instrumentation wrapper emits its post-run
        // event. Recording the code lets the race complete normally so the
        // finalizers run, and `runCli` exits with it once they have.
        processControl
          .awaitSignal()
          .pipe(
            Effect.flatMap((signal) => processControl.setExitCode(signal === "SIGINT" ? 130 : 0)),
          ),
      );
    }).pipe(Effect.ensuring(linkedProjectCache.cache(projectRef)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
