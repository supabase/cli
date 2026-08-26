import { Effect, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyRenderWorkerDetails } from "../workers.format.ts";
import { legacyEmitWorkersMachineOutput, legacyRejectWorkersEnvOutput } from "../workers.output.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import { formatApiSize } from "../../../../shared/workers/worker-runtimes.ts";
import { workerUrl } from "../../../../shared/workers/worker-url.ts";
import { getWorker } from "../../../../shared/workers/workers-api.ts";
import { WorkerNotDeployedError } from "../../../../shared/workers/workers.errors.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyDescribeWorkerForReporting,
  legacyLoadWorkersProject,
  legacyValidateWorkerName,
} from "../workers.shared.ts";
import type { LegacyWorkersStatusFlags } from "./status.command.ts";

/**
 * `supabase workers status [name]` — everything known about one worker.
 *
 * `list`'s companion: the size, image and URL a `push` printed once and then
 * scrolled away, plus the live instance tally, which is the only place it is
 * available — the list endpoint stays free of per-worker backend calls.
 */
export const legacyWorkersStatus = Effect.fn("legacy.workers.status")(function* (
  flags: LegacyWorkersStatusFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const settings = yield* LegacyCliSettings;

  // The ref is resolved outside the finalizers because caching it is one of
  // them; everything that can fail on its own — loading `config.toml`,
  // validating the name, resolving the worker — belongs inside, so those
  // failures still flush telemetry. Same shape as `config/push`.
  const projectRef = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* legacyLoadWorkersProject();
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
          suggestion: `Deploy it with \`supabase workers push ${name}\`.`,
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
    const sourceDisplay =
      worker.entry !== undefined || worker.sourceExists
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
    if (yield* legacyEmitWorkersMachineOutput(payload)) {
      return;
    }

    // One structured emission, in the structured branch only. Calling
    // `output.success` before this check emitted the payload twice: the JSON
    // layer appends each success to stdout, so `JSON.parse` failed, and
    // `stream-json` saw two terminal result events.
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
        "Instances",
        record.instances !== undefined
          ? `${record.instances.ready}/${record.spec.instances} ready, ${record.instances.live} live, ${record.instances.stale} stale`
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
      yield* output.raw(`Instance counts could not be read: ${record.instancesError}\n`, "stderr");
    }
    if (record.buildState === "failed") {
      yield* output.raw(`Fix the issue, then re-run supabase workers push ${name}.\n`);
    }
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
