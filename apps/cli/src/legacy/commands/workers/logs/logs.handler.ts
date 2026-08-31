import { Effect, Option, Ref, Schedule } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
import {
  legacyEmitWorkersMachineOutput,
  legacyRejectWorkersEnvOutput,
  legacyWorkersProjectRefSuffix,
} from "../workers.output.ts";
import { legacyRenderWorkerLogLine, legacyWorkerLogLevel } from "../workers-logs.format.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { LegacyWorkersFollowNotSupportedError } from "../workers.errors.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
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
  type WorkerLogSourceChoice,
} from "../../../../shared/workers/worker-logs.sql.ts";
import { getWorker } from "../../../../shared/workers/workers-api.ts";
import { WorkerNotDeployedError } from "../../../../shared/workers/workers.errors.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyValidateWorkerName } from "../workers.shared.ts";
import { legacyWorkersMachineOutputRequested } from "../workers.output.ts";
import type { LegacyWorkersLogsFlags } from "./logs.command.ts";

/**
 * `supabase workers logs <name>` — what the worker has actually been doing.
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

export const legacyWorkersLogs = Effect.fn("legacy.workers.logs")(function* (
  flags: LegacyWorkersLogsFlags,
  options: LegacyWorkersLogsOptions = {},
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const processControl = yield* ProcessControl;

  // The ref is resolved outside the finalizers because caching it is one of them;
  // everything that can fail on its own belongs inside, so those failures still
  // flush telemetry. Same shape as the rest of the family.
  const projectRef = yield* resolver.resolve(flags.projectRef);
  const refSuffix = legacyWorkersProjectRefSuffix(flags.projectRef);

  yield* Effect.gen(function* () {
    const name = yield* legacyValidateWorkerName(flags.name);

    // Up front, like the rest of the family: this payload always carries a `logs`
    // array, so `-o env` can never encode it, and finding that out at emit time
    // means failing after the query has already been paid for.
    yield* legacyRejectWorkersEnvOutput();

    // Also up front: a tail has no single terminal payload, so the bounded
    // machine formats cannot express it. `stream-json` can, and is allowed.
    if (flags.follow) {
      const machineOutput = yield* legacyWorkersMachineOutputRequested();
      if (machineOutput || output.format === "json") {
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
    // A poll asks for whatever arrived since the cursor, not for `--tail` lines;
    // `--tail 0` means "no history", not "no new lines".
    const pollTail = Math.max(flags.tail, 1);

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
        if (output.format === "stream-json") {
          for (const entry of batch) {
            const level = legacyWorkerLogLevel(entry);
            yield* output.event({
              type: "log-entry",
              timestamp: new Date(entry.timestampMs).toISOString(),
              service: name,
              stream: level === "error" || level === "warn" ? "stderr" : "stdout",
              line: entry.message,
              source: origin,
            });
          }
          return;
        }
        yield* output.raw(`${batch.map((entry) => legacyRenderWorkerLogLine(entry)).join("\n")}\n`);
      });

    const streams = Option.isSome(flags.source)
      ? [WORKER_LOG_STREAMS[flags.source.value as WorkerLogSourceChoice]]
      : ALL_WORKER_LOG_STREAMS;

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
    // Skipped when `--tail 0` asked for no history: no query was made, so zero
    // rows says nothing about whether the worker exists.
    if (entries.length === 0 && flags.tail > 0) {
      const deployed = yield* getWorker(api, projectRef, name);
      if (Option.isNone(deployed)) {
        return yield* Effect.fail(
          new WorkerNotDeployedError({
            detail: `Nothing is deployed for "${name}" in project ${projectRef}.`,
            suggestion: `Deploy it with \`supabase workers push ${name}${refSuffix}\`.`,
          }),
        );
      }
    }

    const payload = {
      worker_name: name,
      project_ref: projectRef,
      ...(Option.isSome(flags.source) ? { source: flags.source.value } : {}),
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
    if (!flags.follow && output.format !== "text") {
      yield* output.success("", payload);
      return;
    }

    if (entries.length === 0 && !flags.follow) {
      // Deployed (the check above would have failed otherwise) and silent.
      yield* output.raw(`No logs for "${name}" in the last 24 hours.\n`);
      yield* emitSuccessTrailer(
        `Check it is running with ${legacyAqua(`supabase workers status ${name}${refSuffix}`)}.\n`,
      );
      return;
    }

    // Oldest first: the query orders newest-first so `limit` means "most recent",
    // but a reader scrolls forwards through time, and a stack trace only makes
    // sense in the order it was printed.
    yield* emitLines(entries);

    // A tail with nothing to show yet would otherwise look like a hang. On stderr,
    // so it never lands in piped output.
    if (flags.follow && entries.length === 0 && output.format === "text") {
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
    const newestSeenMs = yield* Ref.make(
      entries.length === 0 ? Date.now() : entries[entries.length - 1]!.timestampMs,
    );

    const pollOnce = Effect.gen(function* () {
      const cursor = yield* Ref.get(newestSeenMs);
      const rows = yield* fetchWorkerLogs(api, projectRef, {
        name,
        streams,
        tail: pollTail,
        window: followWindow(new Date(), cursor),
      });

      // Windows always overlap - the server rounds them to the minute and the
      // cursor deliberately lags - so dedupe is what makes the overlap invisible
      // rather than a source of repeats.
      const printed = yield* Ref.get(seenIds);
      const fresh = rows.filter((row) => !printed.has(row.id));
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
    // spending the rate limit.
    const poll = pollOnce.pipe(Effect.retry({ schedule: readRetrySchedule }));

    // `repeat` runs the body before applying the schedule, so the first poll is
    // immediate. That is wanted: it catches anything that landed while the history
    // query was in flight, and the rows it repeats are discarded by the id dedupe.
    // Measured cost is ~7 requests in the worst 60-second window, against a limit
    // of 10.
    yield* Effect.raceFirst(
      poll.pipe(Effect.repeat({ schedule: pollSchedule })),
      processControl
        .awaitSignal()
        .pipe(Effect.flatMap((signal) => processControl.exit(signal === "SIGINT" ? 130 : 0))),
    );
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
