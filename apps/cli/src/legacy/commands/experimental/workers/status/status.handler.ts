import { Effect, Option } from "effect";
import { Output } from "../../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../../shared/cli/success-trailer.ts";
import { legacyAqua } from "../../../../shared/legacy-colors.ts";
import { legacyRenderWorkerDetails } from "../workers.format.ts";
import { legacyEmitWorkersPayload, legacyRejectWorkersEnvOutput } from "../workers.output.ts";
import { LegacyPlatformApi } from "../../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../../config/legacy-cli-settings.service.ts";
import { displayPath } from "../../../../../shared/workers/worker-paths.ts";
import { formatApiSize } from "../../../../../shared/workers/worker-runtimes.ts";
import { workerUrl } from "../../../../../shared/workers/worker-url.ts";
import { getWorker } from "../../../../../shared/workers/workers-api.ts";
import { WorkerNotDeployedError } from "../../../../../shared/workers/workers.errors.ts";
import {
  legacyDescribeWorkerForReporting,
  legacyLoadWorkersProjectForReporting,
  legacyValidateWorkerName,
} from "../workers.shared.ts";
import { legacyWorkersRun } from "../workers.run.ts";
import type { LegacyWorkersStatusFlags } from "./status.command.ts";

/**
 * `supabase experimental workers status [name]` — everything known about one worker.
 *
 * `list`'s companion: the size, image and URL a `push` printed once and then
 * scrolled away, plus the live instance tally, which is the only place it is
 * available — the list endpoint stays free of per-worker backend calls.
 */
export const legacyWorkersStatus = Effect.fn("legacy.experimental.workers.status")(function* (
  flags: LegacyWorkersStatusFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const settings = yield* LegacyCliSettings;

  yield* legacyWorkersRun(flags.projectRef, ({ projectRef, refSuffix }) =>
    Effect.gen(function* () {
      const project = yield* legacyLoadWorkersProjectForReporting();
      const name = yield* legacyValidateWorkerName(flags.name);
      const worker = yield* legacyDescribeWorkerForReporting(project, name);

      // Up front, like the rest of the family: discovering an unencodable format
      // at emit time means failing after the fetch has already been paid for.
      yield* legacyRejectWorkersEnvOutput();

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
      // Reported only when an entry or the directory establishes it. With neither,
      // the path is an inference about a worker that may have been deployed from
      // another checkout.
      //
      // `sourceResolved` matters for the entry half: when the configured `source`
      // could not be resolved, `sourceDir` is the *default* directory standing in
      // for it, and printing that would name a path the entry does not.
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
      if (yield* legacyEmitWorkersPayload(payload)) {
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
          // `instances.ready` with `spec.instances` compares a snapshot against
          // the desired count, which mid-scale renders fractions like `3/1 ready`.
          "Instances",
          record.instances !== undefined
            ? `${record.instances.ready}/${record.instances.declared} ready, ${record.instances.live} live, ${record.instances.stale} stale`
            : `${record.spec.instances} declared`,
        ],
        ["URL", url ?? ""],
        ["Project", projectRef],
        // `legacyRenderWorkerDetails` drops empty-valued rows, so an unknown
        // source omits the row rather than printing a guess.
        ["Source", sourceDisplay ?? ""],
      ];

      yield* output.raw(legacyRenderWorkerDetails(details));

      if (record.instances === undefined && record.instancesError !== undefined) {
        yield* output.raw(
          `Instance counts could not be read: ${record.instancesError}\n`,
          "stderr",
        );
      }
      // Not while it is being torn down: deletion is asynchronous, so a push here
      // races the tombstone or resurrects the very worker the user is removing.
      if (record.buildState === "failed" && record.deleting !== true) {
        // Trailer, like every other "what to run next" line in this shell: the
        // command reports a failed build but exits 0, so the trailer flushes.
        yield* emitSuccessTrailer(
          `Fix the issue, then re-run ${legacyAqua(`supabase experimental workers push ${name}${refSuffix}`)}.\n`,
        );
      }
    }),
  );
});
