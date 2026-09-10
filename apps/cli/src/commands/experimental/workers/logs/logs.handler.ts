import { Effect, Option, Ref, Schedule } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { aqua } from "../../../../command-internal/colors.ts";
import {
  emitWorkersMachineOutput,
  rejectWorkersEnvOutput,
  workersProjectRefSuffix,
} from "../workers.output.ts";
import { renderWorkerLogLine, workerLogLevel, workerLogText } from "../workers-logs.format.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { WorkersFollowNotSupportedError } from "../workers.errors.ts";
import { CommandPlatformApi } from "../../../../auth/command-platform-api.service.ts";
import {
  fetchWorkerLogs,
  type WorkerLogEntry,
} from "../../../../shared/workers/worker-logs-api.ts";
import {
  ALL_WORKER_LOG_STREAMS,
  followWindow,
  logWindow,
  WORKER_LOG_POLL_SECONDS,
  WORKER_LOG_STREAMS,
} from "../../../../shared/workers/worker-logs.sql.ts";
import { getWorker } from "../../../../shared/workers/workers-api.ts";
import {
  WorkerLogsQueryFailedError,
  WorkerLogsRateLimitedError,
  WorkerNotDeployedError,
  WorkersApiNetworkError,
  WorkersApiUnexpectedStatusError,
} from "../../../../shared/workers/workers.errors.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { validateWorkerName } from "../workers.shared.ts";
import { workersMachineOutputRequested, workersRenderFormat } from "../workers.output.ts";
import type { WorkersLogsFlags } from "./logs.command.ts";

/**
 * `supabase experimental workers logs <name>` — what the worker has actually been doing.
 *
 * `status` reports the deployment; this reports the runtime. It reads the
 * project's unified logs stream rather than a worker-scoped route — see
 * `worker-logs.sql.ts` for the query and why it filters on `log_attributes`.
 */

/**
 * How many printed ids the follow loop remembers, bounded well above one grace
 * window's worth so it can't cause a repeat while still capping growth for a
 * long-running tail.
 */
const SEEN_ID_LIMIT = 5000;

/**
 * How many rows one poll asks for per request, independent of `--tail` (which
 * only bounds the history a run opens with). Sharing them meant a small
 * `--tail` polled with the same small limit: a burst larger than that limit
 * came back as its newest rows alone, and the cursor advanced past the rest,
 * dropping them for good.
 */
const FOLLOW_PAGE_SIZE = 1000;

/**
 * How many requests one poll may spend draining a burst — bounded because the
 * endpoint allows only 10 requests/minute, so an unbounded drain could spend a
 * whole window's allowance on one poll. The drain walks backward from the
 * newest row, so rows past this bound are dropped for good, not just delayed;
 * the tail reports this on stderr rather than silently losing the gap.
 */
const FOLLOW_MAX_PAGES = 5;

/**
 * How long one poll may keep failing before the tail gives up. Bounded by
 * elapsed time rather than attempts, and spaced, so a 429 or a momentary blip
 * is ridden out without spending the rate limit on retries.
 */
const FOLLOW_READ_RETRY = Schedule.spaced("5 seconds").pipe(
  Schedule.upTo({ duration: "1 minute" }),
);

/**
 * Which poll failures are worth spending another request on. Server-side
 * statuses and 408/429 are retryable (the server is asking for exactly that);
 * other client errors answer the same way every time, so retrying just burns
 * the rate limit for a minute with no chance of success.
 */
function isRetryableFollowFailure(error: unknown): boolean {
  if (error instanceof WorkersApiUnexpectedStatusError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return (
    error instanceof WorkerLogsRateLimitedError ||
    error instanceof WorkersApiNetworkError ||
    // The endpoint's own suggestion is to retry a rejected or timed-out query shortly.
    error instanceof WorkerLogsQueryFailedError
  );
}

/**
 * Test seams for the follow loop: the real schedules are spaced in seconds, so
 * a test exercising the cursor, dedupe, or retry path shouldn't wait on a wall clock.
 */
export interface WorkersLogsOptions {
  readonly pollSchedule?: Schedule.Schedule<unknown>;
  readonly retrySchedule?: Schedule.Schedule<unknown>;
}

/** The machine-format row for one line. */
function toPayloadEntry(entry: WorkerLogEntry) {
  const level = workerLogLevel(entry);
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

export const workersLogs = Effect.fn("experimental.workers.logs")(function* (
  flags: WorkersLogsFlags,
  options: WorkersLogsOptions = {},
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const processControl = yield* ProcessControl;

  // Telemetry wraps ref resolution too, since an unlinked non-interactive
  // checkout fails inside `resolve` after the command has already run. Only the
  // linked-project cache stays under the ref, since it has nothing to write without one.
  yield* Effect.gen(function* () {
    const projectRef = yield* resolver.resolve(flags.projectRef);
    const refSuffix = workersProjectRefSuffix(flags.projectRef);

    yield* Effect.gen(function* () {
      const name = yield* validateWorkerName(flags.name);

      // Checked up front: this payload always carries a `logs` array, which `-o env`
      // can never encode, so failing at emit time would mean paying for the query first.
      yield* rejectWorkersEnvOutput();

      // Resolved once, before anything branches: `-o` outranks `--output-format`, so
      // `output.format` alone isn't what this run renders in.
      const renderFormat = yield* workersRenderFormat();

      // Also up front: a tail has no single terminal payload, so the bounded
      // machine formats cannot express it. `stream-json` can, and is allowed.
      if (flags.follow) {
        const machineOutput = yield* workersMachineOutputRequested();
        if (machineOutput || renderFormat === "json") {
          return yield* new WorkersFollowNotSupportedError({
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
       * Writes a batch of lines out in whichever form the format calls for.
       *
       * `stream-json` emits a `log-entry` event per line rather than one terminal
       * `result`, since a tail has no terminal element; `stream` is derived from
       * the level, and `source` distinguishes backlog from newly arrived lines.
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
              const level = workerLogLevel(entry);
              yield* output.event({
                type: "log-entry",
                timestamp: new Date(entry.timestampMs).toISOString(),
                service: name,
                stream: level === "error" || level === "warn" ? "stderr" : "stdout",
                // Composed the same way text mode renders it: request status/duration
                // and a build's reason live in `log_attributes`, with no separate field for them here.
                line: workerLogText(entry),
                source: origin,
              });
            }
            return;
          }
          yield* output.raw(
            `${batch.map((entry) => renderWorkerLogLine(entry, { showStream })).join("\n")}\n`,
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

      // Zero rows means either an undeployed worker or a deployed, quiet one — worth
      // one extra request to tell apart, and only here: `--tail 0` makes no history
      // query, so zero rows there says nothing (and a bounded `--tail 0` run prints
      // nothing by definition, so it's left alone).
      if (entries.length === 0 && (flags.tail > 0 || flags.follow)) {
        // Its own task: `--tail 0` skips "Fetching logs...", and reusing/clearing
        // that one before this call left text mode silent while it ran.
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
      // it. Unreachable while following, since that combination is refused above.
      if (!flags.follow && (yield* emitWorkersMachineOutput(payload))) {
        return;
      }

      // Only for a bounded (non-follow) read — a tail has no terminal payload; it
      // emits a `log-entry` event per line via `emitLines` instead.
      if (!flags.follow && renderFormat !== "text") {
        yield* output.success("", payload);
        return;
      }

      if (entries.length === 0 && !flags.follow) {
        // Deployed (the check above would have failed otherwise) and silent.
        yield* output.raw(`No logs for "${name}" in the last 24 hours.\n`);
        yield* emitSuccessTrailer(
          `Check it is running with ${aqua(`supabase experimental workers status ${name}${refSuffix}`)}.\n`,
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

      // The cursor is the newest timestamp printed, plus the set of printed ids. Both
      // live inside this generator, not a closure built once, since an Effect is a
      // reusable description that may run more than once — shared state across runs
      // would drop lines.
      const seenIds = yield* Ref.make(new Set(entries.map((entry) => entry.id)));
      // Same reason: a notice already shown on a previous run would stay silent on the next.
      const skipNoticeShown = yield* Ref.make(false);
      const newestSeenMs = yield* Ref.make(
        entries.length === 0 ? Date.now() : entries[entries.length - 1]!.timestampMs,
      );

      // `--tail 0` asked for no history, but `followWindow` still reaches a grace
      // period behind the cursor so a late-arriving line is caught; keeping the wide
      // window and filtering by actual timestamp lets both cases coexist.
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

        // Shown once per run, not once per poll, so a sustained burst doesn't repeat
        // this every interval. Emitted in every format (unlike the "Waiting for new
        // logs" notice below) since it reports data loss a machine consumer can't
        // infer from the events themselves.
        if (!drained && !(yield* Ref.get(skipNoticeShown))) {
          yield* Ref.set(skipNoticeShown, true);
          yield* output.raw(
            `Skipped part of a burst larger than ${FOLLOW_MAX_PAGES * FOLLOW_PAGE_SIZE} lines: ` +
              `some lines older than the ones below were not printed. ` +
              `Narrow the stream with --kind, or read the full range in the dashboard.\n`,
            "stderr",
          );
        }

        // Windows always overlap — the server rounds to the minute and the cursor
        // lags behind on purpose — so dedupe is what makes the overlap invisible.
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

      // A 429 or a blip should not end a tail the user is watching; the spaced
      // schedule rides out a transient failure without spending the rate limit.
      // Anything definitive surfaces on the first attempt.
      const poll = pollOnce.pipe(
        Effect.retry({ schedule: readRetrySchedule, while: isRetryableFollowFailure }),
      );

      // `repeat` runs the body before applying the schedule, so the first poll is
      // immediate and the id dedupe discards anything that repeats. Against the
      // endpoint's 10-requests-per-minute limit, a quiet tail spends about 6; a poll
      // draining a burst can spend up to `FOLLOW_MAX_PAGES`, reaching 30 and getting
      // rate limited, which the retry schedule treats as transient rather than fatal.
      yield* Effect.raceFirst(
        poll.pipe(Effect.repeat({ schedule: pollSchedule })),
        // `setExitCode`, not `exit`: the production `exit` calls `process.exit`
        // synchronously, tearing the runtime down before the linked-project cache is
        // written, telemetry flushed, or the instrumentation wrapper's post-run event
        // fires. This lets the race complete normally so those finalizers run.
        processControl
          .awaitSignal()
          .pipe(
            Effect.flatMap((signal) => processControl.setExitCode(signal === "SIGINT" ? 130 : 0)),
          ),
      );
    }).pipe(Effect.ensuring(linkedProjectCache.cache(projectRef)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
