import { Effect, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { renderWorkerDetails } from "../workers.format.ts";
import { legacyEmitWorkersGoOutput } from "../workers.output.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import { formatApiSize } from "../../../../shared/workers/worker-runtimes.ts";
import { workerUrl } from "../../../../shared/workers/worker-url.ts";
import { getWorker } from "../../../../shared/workers/workers-api.ts";
import { WorkerNotDeployedError } from "../../../../shared/workers/workers.errors.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyDescribeWorker,
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
  const cliConfig = yield* LegacyCliConfig;

  const project = yield* legacyLoadWorkersProject();
  const name = yield* legacyValidateWorkerName(flags.name);
  const worker = legacyDescribeWorker(project, name);
  const projectRef = yield* resolver.resolve(flags.projectRef);

  // Go writes the linked-project cache and flushes telemetry in
  // `PersistentPostRun`, so both happen whether the command succeeds or fails.
  yield* Effect.gen(function* () {
    const fetching = yield* output.task(`Reading "${name}"...`);
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
        ? workerUrl(projectRef, cliConfig.projectHost, name)
        : undefined;
    const sourceDisplay = displayPath(project.projectRoot, worker.sourceDir);

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
      source: sourceDisplay,
      ...(url === undefined ? {} : { url }),
    };

    // `-o` asks for a machine-readable stdout, so nothing human may be written
    // to it — `output.success` logs to stdout in text mode.
    if (yield* legacyEmitWorkersGoOutput(payload)) {
      return;
    }

    yield* output.success("Read worker.", payload);

    if (output.format !== "text") {
      yield* output.success("", payload);
      return;
    }

    const details: Array<readonly [string, string]> = [
      ["state", record.deleting === true ? "deleting" : record.buildState],
      ...(record.stateReason === undefined
        ? []
        : ([["reason", record.stateReason]] as Array<readonly [string, string]>)),
      ["runtime", record.spec.runtime ?? "dockerfile"],
      ["size", formatApiSize(record.spec.size)],
      ["access", record.spec.exposure],
      ["project", projectRef],
      ...(record.imageVersion === undefined
        ? []
        : ([["image", record.imageVersion]] as Array<readonly [string, string]>)),
      [
        "instances",
        record.instances !== undefined
          ? `${record.instances.ready}/${record.spec.instances} ready · ${record.instances.live} live · ${record.instances.stale} stale`
          : `${record.spec.instances} declared`,
      ],
      ...(url === undefined ? [] : ([["url", url]] as Array<readonly [string, string]>)),
      ["source", sourceDisplay],
    ];

    yield* output.raw(renderWorkerDetails(details));

    if (record.instances === undefined && record.instancesError !== undefined) {
      yield* output.raw(`Instance counts could not be read: ${record.instancesError}\n`, "stderr");
    }
    if (record.buildState === "failed") {
      yield* output.raw(`  → try again: supabase workers push ${name}\n`);
    }
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
