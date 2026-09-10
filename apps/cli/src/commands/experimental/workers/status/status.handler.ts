import { Effect, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { aqua } from "../../../../command-internal/colors.ts";
import { renderWorkerDetails } from "../workers.format.ts";
import {
  emitWorkersMachineOutput,
  rejectWorkersEnvOutput,
  workersProjectRefSuffix,
} from "../workers.output.ts";
import { CommandPlatformApi } from "../../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import { formatApiSize } from "../../../../shared/workers/worker-runtimes.ts";
import { workerUrl } from "../../../../shared/workers/worker-url.ts";
import { getWorker } from "../../../../shared/workers/workers-api.ts";
import { WorkerNotDeployedError } from "../../../../shared/workers/workers.errors.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  describeWorkerForReporting,
  loadWorkersProjectForReporting,
  validateWorkerName,
} from "../workers.shared.ts";
import type { WorkersStatusFlags } from "./status.command.ts";

/**
 * `supabase experimental workers status [name]` — everything known about one worker.
 *
 * `list`'s companion: the size, image and URL a `push` printed once and then
 * scrolled away, plus the live instance tally, which is the only place it is
 * available — the list endpoint stays free of per-worker backend calls.
 */
export const workersStatus = Effect.fn("experimental.workers.status")(function* (
  flags: WorkersStatusFlags,
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const settings = yield* CommandSettings;

  // Resolved here, outside the block below, since caching it is one of that
  // block's own finalizers — everything else that can fail belongs inside so
  // those failures still flush telemetry.
  const projectRef = yield* resolver.resolve(flags.projectRef);
  const refSuffix = workersProjectRefSuffix(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* loadWorkersProjectForReporting();
    const name = yield* validateWorkerName(flags.name);
    const worker = yield* describeWorkerForReporting(project, name);

    // Checked up front: discovering an unencodable format at emit time would
    // mean failing after the fetch has already been paid for.
    yield* rejectWorkersEnvOutput();

    const fetching = yield* output.task("Fetching worker...");
    const found = yield* getWorker(api, projectRef, name).pipe(
      Effect.tapError(() => fetching.fail()),
    );
    yield* fetching.clear();

    if (Option.isNone(found)) {
      return yield* Effect.fail(
        new WorkerNotDeployedError({
          detail: `Nothing is deployed for "${name}" in project ${projectRef}.`,
          suggestion: `Deploy it with \`supabase experimental workers push ${name}${refSuffix}\`.`,
        }),
      );
    }

    const record = found.value;
    const url =
      record.spec.exposure === "public"
        ? workerUrl(projectRef, settings.projectHost, name)
        : undefined;
    // Reported only when an entry or the directory establishes it; with
    // neither, the path is an inference about a worker deployed elsewhere.
    // `sourceResolved` matters for the entry half: when `source` couldn't be
    // resolved, `sourceDir` is the default directory standing in for it.
    const sourceDisplay =
      (worker.entry !== undefined && worker.sourceResolved) || worker.sourceExists
        ? displayPath(project.projectRoot, worker.sourceDir)
        : undefined;

    const payload = {
      worker_name: name,
      project_ref: projectRef,
      runtime: record.spec.runtime ?? "dockerfile",
      size: record.spec.size,
      exposure: record.spec.exposure,
      build_state: record.buildState,
      state_reason: record.stateReason,
      image_version: record.imageVersion,
      deleting: record.deleting,
      declared_instances: record.spec.instances,
      instances: record.instances,
      instances_error: record.instancesError,
      ...(sourceDisplay === undefined ? {} : { source: sourceDisplay }),
      ...(url === undefined ? {} : { url }),
    };

    // `-o` asks for a machine-readable stdout, so nothing human may be written
    // to it — `output.success` logs to stdout in text mode.
    if (yield* emitWorkersMachineOutput(payload)) {
      return;
    }

    // Checked after `emitWorkersMachineOutput`: calling `output.success` before
    // it emitted the payload twice, since the JSON layer appends each success
    // to stdout.
    if (output.format !== "text") {
      yield* output.success("", payload);
      return;
    }

    const details: Array<readonly [string, string]> = [
      ["State", record.deleting === true ? "deleting" : record.buildState],
      ["Reason", record.stateReason ?? ""],
      ["Runtime", record.spec.runtime ?? "dockerfile"],
      ["Size", formatApiSize(record.spec.size)],
      ["Image", record.imageVersion ?? ""],
      ["Access", record.spec.exposure],
      [
        // Every number in the tally line comes from the tally: mixing
        // `instances.ready` with `spec.instances` would render fractions like
        // `3/1 ready` mid-scale.
        "Instances",
        record.instances !== undefined
          ? `${record.instances.ready}/${record.instances.declared} ready, ${record.instances.live} live, ${record.instances.stale} stale`
          : `${record.spec.instances} declared`,
      ],
      ["URL", url ?? ""],
      ["Project", projectRef],
      ["Source", sourceDisplay ?? ""],
    ];

    yield* output.raw(renderWorkerDetails(details));

    if (record.instances === undefined && record.instancesError !== undefined) {
      yield* output.raw(`Instance counts could not be read: ${record.instancesError}\n`, "stderr");
    }
    // Not while it is being torn down: deletion is asynchronous, so a push here
    // races the tombstone or resurrects the very worker the user is removing.
    if (record.buildState === "failed" && record.deleting !== true) {
      // A trailer, since the command reports a failed build but exits 0.
      yield* emitSuccessTrailer(
        `Fix the issue, then re-run ${aqua(`supabase experimental workers push ${name}${refSuffix}`)}.\n`,
      );
    }
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
