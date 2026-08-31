import { Effect, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
import {
  legacyEmitWorkersMachineOutput,
  legacyRejectWorkersEnvOutput,
  legacyWorkersProjectRefSuffix,
} from "../workers.output.ts";
import { legacyRenderWorkerLogLine, legacyWorkerLogLevel } from "../workers-logs.format.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import {
  fetchWorkerLogs,
  type WorkerLogEntry,
} from "../../../../shared/workers/worker-logs-api.ts";
import {
  ALL_WORKER_LOG_STREAMS,
  logWindow,
  WORKER_LOG_STREAMS,
  type WorkerLogSourceChoice,
} from "../../../../shared/workers/worker-logs.sql.ts";
import { getWorker } from "../../../../shared/workers/workers-api.ts";
import { WorkerNotDeployedError } from "../../../../shared/workers/workers.errors.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyValidateWorkerName } from "../workers.shared.ts";
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
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

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
    if (entries.length === 0) {
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
    // it — `output.success` logs to stdout in text mode.
    if (yield* legacyEmitWorkersMachineOutput(payload)) {
      return;
    }

    // One structured emission, in the structured branch only. Emitting before the
    // check above put the payload on stdout twice.
    if (output.format !== "text") {
      yield* output.success("", payload);
      return;
    }

    if (entries.length === 0) {
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
    // No TTY check here: `legacyRenderWorkerLogLine` defaults to `process.stdout`
    // and the colour helpers gate on it themselves, honouring NO_COLOR, CLICOLOR,
    // CLICOLOR_FORCE and CI as well as the stream.
    yield* output.raw(`${entries.map((entry) => legacyRenderWorkerLogLine(entry)).join("\n")}\n`);
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
