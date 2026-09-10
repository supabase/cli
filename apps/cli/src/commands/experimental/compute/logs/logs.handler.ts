import { Clock, DateTime, Effect, Option, Ref, Schedule } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { aqua } from "../../../../command-internal/colors.ts";
import {
  emitComputeMachineOutput,
  rejectComputeEnvOutput,
  computeProjectRefSuffix,
} from "../compute.output.ts";
import { renderComputeLogLine, computeLogLevel, computeLogText } from "../compute-logs.format.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { ComputeFollowNotSupportedError } from "../compute.errors.ts";
import { CommandPlatformApi } from "../../../../auth/command-platform-api.service.ts";
import {
  fetchComputeLogs,
  type ComputeLogEntry,
} from "../../../../shared/compute/compute-logs-api.ts";
import {
  ALL_COMPUTE_LOG_STREAMS,
  followWindow,
  logWindow,
  COMPUTE_LOG_POLL_SECONDS,
  COMPUTE_LOG_STREAMS,
} from "../../../../shared/compute/compute-logs.sql.ts";
import { getCompute } from "../../../../shared/compute/compute-api.ts";
import {
  ComputeLogsQueryFailedError,
  ComputeLogsRateLimitedError,
  ComputeNotDeployedError,
  ComputeApiNetworkError,
  ComputeApiUnexpectedStatusError,
} from "../../../../shared/compute/compute.errors.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { validateComputeName } from "../compute.shared.ts";
import { computeMachineOutputRequested, computeRenderFormat } from "../compute.output.ts";
import type { ComputeLogsFlags } from "./logs.command.ts";

/**
 * `supabase compute logs <name>` — what the compute has actually been doing.
 *
 * `status` reports the deployment; this reports the runtime. It reads the
 * project's unified logs stream rather than a compute-scoped route — see
 * `compute-logs.sql.ts` for the query and why it filters on `log_attributes`.
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
  if (error instanceof ComputeApiUnexpectedStatusError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return (
    error instanceof ComputeLogsRateLimitedError ||
    error instanceof ComputeApiNetworkError ||
    // The endpoint reports a rejected or timed-out query this way, and its own
    // suggestion is to retry shortly.
    error instanceof ComputeLogsQueryFailedError
  );
}

/**
 * Test seams for the follow loop.
 *
 * Both schedules are parameters for the same reason `awaitComputeBuild`'s are: the
 * real ones are spaced in seconds, and a test exercising the cursor, the dedupe,
 * or the retry path should not wait on a wall clock to do it.
 */
export interface ComputeLogsOptions {
  readonly pollSchedule?: Schedule.Schedule<unknown>;
  readonly retrySchedule?: Schedule.Schedule<unknown>;
}

/** The machine-format row for one line. */
function toPayloadEntry(entry: ComputeLogEntry) {
  const level = computeLogLevel(entry);
  return {
    id: entry.id,
    // Both forms: the ISO string is what a human or `jq` wants to read, the raw
    // epoch value is what a script sorts or diffs on without reparsing.
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(entry.timestampMs)),
    timestamp_ms: entry.timestampMs,
    stream: entry.stream,
    message: entry.message,
    ...(level === undefined ? {} : { level }),
    attributes: entry.attributes,
  };
}

export const computeLogs = Effect.fn("compute.logs")(function* (
  flags: ComputeLogsFlags,
  options: ComputeLogsOptions = {},
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
    const refSuffix = computeProjectRefSuffix(flags.projectRef);

    yield* Effect.gen(function* () {
      const name = yield* validateComputeName(flags.name);

      // Up front, like the rest of the family: this payload always carries a `logs`
      // array, so `-o env` can never encode it, and finding that out at emit time
      // means failing after the query has already been paid for.
      yield* rejectComputeEnvOutput();

      // Resolved once, before anything branches: `-o` outranks `--output-format`,
      // so `output.format` on its own is not what this run renders in.
      const renderFormat = yield* computeRenderFormat();

      // Also up front: a tail has no single terminal payload, so the bounded
      // machine formats cannot express it. `stream-json` can, and is allowed.
      if (flags.follow) {
        const machineOutput = yield* computeMachineOutputRequested();
        if (machineOutput || renderFormat === "json") {
          return yield* new ComputeFollowNotSupportedError({
            message:
              "--follow cannot be combined with a single-payload output format. " +
              "Use --output-format stream-json to stream, or drop --follow.",
          });
        }
      }

      const pollSchedule =
        options.pollSchedule ?? Schedule.spaced(`${COMPUTE_LOG_POLL_SECONDS} seconds`);
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
        batch: ReadonlyArray<ComputeLogEntry>,
        origin: "history" | "live" = "history",
      ) =>
        Effect.gen(function* () {
          if (batch.length === 0) {
            return;
          }
          if (renderFormat === "stream-json") {
            for (const entry of batch) {
              const level = computeLogLevel(entry);
              yield* output.event({
                type: "log-entry",
                timestamp: DateTime.formatIso(DateTime.makeUnsafe(entry.timestampMs)),
                service: name,
                stream: level === "error" || level === "warn" ? "stderr" : "stdout",
                // The composed sentence, the same one text mode renders: a
                // request line's status and duration and a build's reason live
                // in `log_attributes`, and `log-entry` has no field to carry
                // them separately.
                line: computeLogText(entry),
                source: origin,
              });
            }
            return;
          }
          yield* output.raw(
            `${batch.map((entry) => renderComputeLogLine(entry, { showStream })).join("\n")}\n`,
          );
        });

      const streams = Option.isSome(flags.kind)
        ? [COMPUTE_LOG_STREAMS[flags.kind.value]]
        : ALL_COMPUTE_LOG_STREAMS;

      // Before any request, so a slow history query or deployed-compute check
      // cannot widen what `followFloorMs` below treats as "already there".
      const startedAtMs = yield* Clock.currentTimeMillis;

      // `--tail 0` is "no history". On its own that is a no-op, but it is the shape
      // `--follow` will want, and issuing a `limit 0` query would be a 400.
      const entries =
        flags.tail === 0
          ? []
          : yield* Effect.gen(function* () {
              const fetching = yield* output.task("Fetching logs...");
              const rows = yield* fetchComputeLogs(api, projectRef, {
                name,
                streams,
                tail: flags.tail,
                window: logWindow(yield* DateTime.now),
              }).pipe(Effect.tapError(() => fetching.fail()));
              yield* fetching.clear();
              return rows;
            });

      // Nothing came back, which is two different situations wearing the same face:
      // a compute that is not deployed at all, and one that is deployed and quiet.
      // Only worth one extra request, and only in this branch.
      //
      // `--tail 0` makes no history query, so zero rows says nothing either way —
      // but a tail still has to know the compute exists, or a typo waits forever on
      // logs that can never arrive. A bounded `--tail 0` run prints nothing by
      // definition and is left alone.
      if (entries.length === 0 && (flags.tail > 0 || flags.follow)) {
        // Its own task: with `--tail 0` there is no "Fetching logs..." to inherit,
        // and clearing that one before this request left text mode silent across
        // a call that can take a moment.
        const checking = yield* output.task("Checking compute...");
        const deployed = yield* getCompute(api, projectRef, name).pipe(
          Effect.tapError(() => checking.fail()),
        );
        yield* checking.clear();
        if (Option.isNone(deployed)) {
          return yield* new ComputeNotDeployedError({
            detail: `Nothing is deployed for "${name}" in project ${projectRef}.`,
            suggestion: `Deploy it with \`supabase compute push ${name}${refSuffix}\`.`,
          });
        }
      }

      const payload = {
        compute_name: name,
        project_ref: projectRef,
        ...(Option.isSome(flags.kind) ? { kind: flags.kind.value } : {}),
        logs: entries.map(toPayloadEntry),
      };

      // `-o` asks for a machine-readable stdout, so nothing human may be written to
      // it — `output.success` logs to stdout in text mode. Unreachable while
      // following, which refuses these formats up front.
      if (!flags.follow && (yield* emitComputeMachineOutput(payload))) {
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
          `Check it is running with ${aqua(`supabase compute status ${name}${refSuffix}`)}.\n`,
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
      const newestSeen = yield* Ref.make<DateTime.Utc>(
        entries.length === 0
          ? yield* DateTime.now
          : DateTime.makeUnsafe(entries[entries.length - 1]!.timestampMs),
      );

      // `--tail 0` asked for no history, but `followWindow` still reaches a grace
      // period behind the cursor so a late-arriving line is caught; keeping the wide
      // window and filtering by actual timestamp lets both cases coexist.
      const followFloorMs = flags.tail === 0 ? startedAtMs : Number.NEGATIVE_INFINITY;

      const pollOnce = Effect.gen(function* () {
        const cursor = yield* Ref.get(newestSeen);

        // One request only ever answers with the newest page of its window, so a
        // burst bigger than a page needs several. Walk `end` backwards while
        // pages come back full; a short page means the window is drained.
        const collected: Array<ComputeLogEntry> = [];
        let end = yield* DateTime.now;
        // A short page is the only proof the window is empty below this point.
        // Both other exits — the page budget running out, and a full page too
        // narrow to walk past — leave rows unfetched underneath.
        let drained = false;
        for (let page = 0; page < FOLLOW_MAX_PAGES; page += 1) {
          const rows = yield* fetchComputeLogs(api, projectRef, {
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
          const nextEnd = DateTime.makeUnsafe(rows[0]!.timestampMs);
          // A full page whose rows all share one timestamp cannot narrow the
          // window: re-requesting it would return the same page forever.
          if (DateTime.toEpochMillis(nextEnd) >= DateTime.toEpochMillis(end)) {
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
          newestSeen,
          DateTime.makeUnsafe(
            fresh.reduce(
              (newest, row) => Math.max(newest, row.timestampMs),
              DateTime.toEpochMillis(cursor),
            ),
          ),
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
