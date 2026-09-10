import { Effect, Option, Path } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { aqua } from "../../../../command-internal/colors.ts";
import { renderComputeDetails } from "../compute.format.ts";
import {
  emitComputeMachineOutput,
  rejectComputeEnvOutput,
  computeProjectRefSuffix,
} from "../compute.output.ts";
import { CommandPlatformApi } from "../../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { displayPath } from "../../../../shared/compute/compute-paths.ts";
import { formatApiSize } from "../../../../shared/compute/compute-runtimes.ts";
import { computeUrl } from "../../../../shared/compute/compute-url.ts";
import { getCompute } from "../../../../shared/compute/compute-api.ts";
import { ComputeNotDeployedError } from "../../../../shared/compute/compute.errors.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  describeComputeForReporting,
  loadComputeProjectForReporting,
  validateComputeName,
} from "../compute.shared.ts";
import type { ComputeStatusFlags } from "./status.command.ts";

/**
 * `supabase compute status [name]` — everything known about one compute.
 *
 * `list`'s companion: the size, image and URL a `push` printed once and then
 * scrolled away, plus the live instance tally, which is the only place it is
 * available — the list endpoint stays free of per-compute backend calls.
 */
export const computeStatus = Effect.fn("compute.status")(function* (flags: ComputeStatusFlags) {
  const output = yield* Output;
  const path = yield* Path.Path;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const settings = yield* CommandSettings;

  // Resolved here, outside the block below, since caching it is one of that
  // block's own finalizers — everything else that can fail belongs inside so
  // those failures still flush telemetry.
  const projectRef = yield* resolver.resolve(flags.projectRef);
  const refSuffix = computeProjectRefSuffix(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* loadComputeProjectForReporting();
    const name = yield* validateComputeName(flags.name);
    const compute = yield* describeComputeForReporting(project, name);

    // Up front, like the rest of the family: discovering an unencodable format
    // at emit time means failing after the fetch has already been paid for.
    yield* rejectComputeEnvOutput();

    const fetching = yield* output.task("Fetching compute...");
    const found = yield* getCompute(api, projectRef, name).pipe(
      Effect.tapError(() => fetching.fail()),
    );
    yield* fetching.clear();

    if (Option.isNone(found)) {
      return yield* new ComputeNotDeployedError({
        detail: `Nothing is deployed for "${name}" in project ${projectRef}.`,
        suggestion: `Deploy it with \`supabase compute push ${name}${refSuffix}\`.`,
      });
    }

    const record = found.value;
    const url =
      record.spec.exposure === "public"
        ? computeUrl(projectRef, settings.projectHost, name)
        : undefined;
    // Reported only when an entry or the directory establishes it; with
    // neither, the path is an inference about a compute deployed elsewhere.
    // `sourceResolved` matters for the entry half: when `source` couldn't be
    // resolved, `sourceDir` is the default directory standing in for it.
    const sourceDisplay =
      (compute.entry !== undefined && compute.sourceResolved) || compute.sourceExists
        ? displayPath(path, project.projectRoot, compute.sourceDir)
        : undefined;

    const payload = {
      compute_name: name,
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
    if (yield* emitComputeMachineOutput(payload)) {
      return;
    }

    // Checked after `emitComputeMachineOutput`: calling `output.success` before
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

    yield* output.raw(renderComputeDetails(details));

    if (record.instances === undefined && record.instancesError !== undefined) {
      yield* output.raw(`Instance counts could not be read: ${record.instancesError}\n`, "stderr");
    }
    // Not while it is being torn down: deletion is asynchronous, so a push here
    // races the tombstone or resurrects the very compute the user is removing.
    if (record.buildState === "failed" && record.deleting !== true) {
      // A trailer, since the command reports a failed build but exits 0.
      yield* emitSuccessTrailer(
        `Fix the issue, then re-run ${aqua(`supabase compute push ${name}${refSuffix}`)}.\n`,
      );
    }
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
