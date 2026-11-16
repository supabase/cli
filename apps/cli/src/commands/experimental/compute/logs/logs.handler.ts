import { followLogs } from "./logs.follow.ts";
import { Clock, DateTime, Effect, Option, Ref, Schedule, Stream } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { aqua } from "../../../../command-internal/colors.ts";
import {
  emitComputeMachineOutput,
  rejectComputeEnvOutput,
  computeRemoteSuffix,
} from "../compute.output.ts";
import { renderComputeLogLine, computeLogLevel, computeLogText } from "../compute-logs.format.ts";
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
import { resolveProjectTarget } from "../../../../command-internal/target/resolve-project-target.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { validateComputeName } from "../compute.shared.ts";
import { computeMachineOutputRequested, computeRenderFormat } from "../compute.output.ts";
import type { ComputeLogsFlags } from "./logs.command.ts";

const SEEN_ID_LIMIT = 5000;

const FOLLOW_PAGE_SIZE = 1000;

const FOLLOW_MAX_PAGES = 5;

const FOLLOW_READ_RETRY = Schedule.spaced("5 seconds").pipe(
  Schedule.upTo({ duration: "1 minute" }),
);

function isRetryableFollowFailure(error: unknown): boolean {
  if (error instanceof ComputeApiUnexpectedStatusError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return (
    error instanceof ComputeLogsRateLimitedError ||
    error instanceof ComputeApiNetworkError ||
    error instanceof ComputeLogsQueryFailedError
  );
}

export interface ComputeLogsOptions {
  readonly pollSchedule?: Schedule.Schedule<unknown>;
  readonly retrySchedule?: Schedule.Schedule<unknown>;
}

interface FollowPage {
  readonly rows: ReadonlyArray<ComputeLogEntry>;
  readonly drained: boolean;
}

interface FollowCursor {
  readonly end: DateTime.Utc;
  readonly page: number;
}

function toPayloadEntry(entry: ComputeLogEntry) {
  const level = computeLogLevel(entry);
  return {
    id: entry.id,

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
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    const projectRef = yield* resolveProjectTarget(flags);
    const refSuffix = computeRemoteSuffix(flags, projectRef);

    yield* Effect.gen(function* () {
      const name = yield* validateComputeName(flags.name);

      yield* rejectComputeEnvOutput();

      const renderFormat = yield* computeRenderFormat();

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

      const showStream = Option.isNone(flags.kind);

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

      const startedAtMs = yield* Clock.currentTimeMillis;

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
              yield* fetching.clear;
              return rows;
            });

      if (entries.length === 0 && (flags.tail > 0 || flags.follow)) {
        const checking = yield* output.task("Checking compute...");
        const deployed = yield* getCompute(api, projectRef, name).pipe(
          Effect.tapError(() => checking.fail()),
        );
        yield* checking.clear;
        if (Option.isNone(deployed)) {
          return yield* new ComputeNotDeployedError({
            detail: `Nothing is deployed for "${name}" in project ${projectRef}.`,
            suggestion: `Deploy it with \`supabase compute push ${name}${refSuffix}\`.`,
          });
        }
      }

      yield* Effect.annotateCurrentSpan({
        "compute.log_count": entries.length,
        "compute.follow": flags.follow,
      });

      const payload = {
        compute_name: name,
        project_ref: projectRef,
        ...(Option.isSome(flags.kind) ? { kind: flags.kind.value } : {}),
        logs: entries.map(toPayloadEntry),
      };

      if (!flags.follow && (yield* emitComputeMachineOutput(payload))) {
        return;
      }

      if (!flags.follow && renderFormat !== "text") {
        yield* output.success("", payload);
        return;
      }

      if (entries.length === 0 && !flags.follow) {
        yield* output.raw(`No logs for "${name}" in the last 24 hours.\n`);
        yield* emitSuccessTrailer(
          `Check it is running with ${aqua(`supabase compute status ${name}${refSuffix}`)}.\n`,
        );
        return;
      }

      yield* emitLines(entries);

      if (flags.follow && entries.length === 0 && renderFormat === "text") {
        yield* output.raw(`Waiting for new logs from "${name}". Press Ctrl+C to stop.\n`, "stderr");
      }

      if (!flags.follow) {
        return;
      }

      const seenIds = yield* Ref.make(new Set(entries.map((entry) => entry.id)));

      const skipNoticeShown = yield* Ref.make(false);
      const newestEntry = entries.at(-1);
      const newestSeen = yield* Ref.make<DateTime.Utc>(
        newestEntry === undefined
          ? yield* DateTime.now
          : DateTime.makeUnsafe(newestEntry.timestampMs),
      );

      const followFloorMs = flags.tail === 0 ? startedAtMs : Number.NEGATIVE_INFINITY;

      const pollAttempts = yield* Ref.make(0);
      const pollOnce = Effect.gen(function* () {
        yield* Ref.update(pollAttempts, (attempts) => attempts + 1);
        const cursor = yield* Ref.get(newestSeen);

        const pages = yield* Stream.paginate(
          { end: yield* DateTime.now, page: 0 },
          ({ end, page }) =>
            fetchComputeLogs(api, projectRef, {
              name,
              streams,
              tail: FOLLOW_PAGE_SIZE,
              window: followWindow(end, cursor),
            }).pipe(
              Effect.map(
                (rows): readonly [ReadonlyArray<FollowPage>, Option.Option<FollowCursor>] => {
                  const oldestRow = rows[0];

                  if (rows.length < FOLLOW_PAGE_SIZE || oldestRow === undefined) {
                    return [[{ rows, drained: true }], Option.none()];
                  }

                  const nextEnd = DateTime.makeUnsafe(oldestRow.timestampMs);

                  if (
                    page + 1 >= FOLLOW_MAX_PAGES ||
                    DateTime.toEpochMillis(nextEnd) >= DateTime.toEpochMillis(end)
                  ) {
                    return [[{ rows, drained: false }], Option.none()];
                  }
                  return [
                    [{ rows, drained: false }],
                    Option.some({ end: nextEnd, page: page + 1 }),
                  ];
                },
              ),
            ),
        ).pipe(Stream.runCollect);
        const collected = pages.flatMap(({ rows }) => rows);
        const drained = pages.at(-1)?.drained === true;

        if (!drained && !(yield* Ref.get(skipNoticeShown))) {
          yield* Ref.set(skipNoticeShown, true);
          yield* output.raw(
            `Skipped part of a burst larger than ${FOLLOW_MAX_PAGES * FOLLOW_PAGE_SIZE} lines: ` +
              `some lines older than the ones below were not printed. ` +
              `Narrow the stream with --kind, or read the full range in the dashboard.\n`,
            "stderr",
          );
        }

        const printed = yield* Ref.get(seenIds);
        const fresh = collected
          .filter((row) => !printed.has(row.id) && row.timestampMs >= followFloorMs)

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

      const poll = pollOnce.pipe(
        Effect.retry({ schedule: readRetrySchedule, while: isRetryableFollowFailure }),
        Effect.withTracerEnabled(false),
      );

      yield* followLogs(poll, pollSchedule).pipe(
        Effect.ensuring(
          Ref.get(pollAttempts).pipe(
            Effect.flatMap((attempts) =>
              Effect.annotateCurrentSpan({ "poll.attempt_count": attempts }),
            ),
          ),
        ),
      );
    }).pipe(Effect.ensuring(linkedProjectCache.cache(projectRef)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
