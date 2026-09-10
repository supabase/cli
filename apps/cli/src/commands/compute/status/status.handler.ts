import { Effect, Option } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../shared/cli/success-trailer.ts";
import { aqua } from "../../../command-internal/colors.ts";
import { renderComputeDetails } from "../compute.format.ts";
import {
  emitComputeMachineOutput,
  rejectComputeEnvOutput,
  computeProjectRefSuffix,
} from "../compute.output.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { displayPath } from "../../../shared/compute/compute-paths.ts";
import { formatApiSize } from "../../../shared/compute/compute-runtimes.ts";
import { computeUrl } from "../../../shared/compute/compute-url.ts";
import { getCompute } from "../../../shared/compute/compute-api.ts";
import { ComputeNotDeployedError } from "../../../shared/compute/compute.errors.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
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
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const settings = yield* CommandSettings;

  // The ref is resolved outside the finalizers because caching it is one of
  // them; everything that can fail on its own — loading `config.toml`,
  // validating the name, resolving the compute — belongs inside, so those
  // failures still flush telemetry. Same shape as `config/push`.
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
      return yield* Effect.fail(
        new ComputeNotDeployedError({
          detail: `Nothing is deployed for "${name}" in project ${projectRef}.`,
          suggestion: `Deploy it with \`supabase compute push ${name}${refSuffix}\`.`,
        }),
      );
    }

    const record = found.value;
    const url =
      record.spec.exposure === "public"
        ? computeUrl(projectRef, settings.projectHost, name)
        : undefined;
    // Reported only when an entry or the directory establishes it. With neither,
    // the path is an inference about a compute that may have been deployed from
    // another checkout.
    //
    // `sourceResolved` matters for the entry half: when the configured `source`
    // could not be resolved, `sourceDir` is the *default* directory standing in
    // for it, and printing that would name a path the entry does not.
    const sourceDisplay =
      (compute.entry !== undefined && compute.sourceResolved) || compute.sourceExists
        ? displayPath(project.projectRoot, compute.sourceDir)
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
      // `renderComputeDetails` drops empty-valued rows, so an unknown
      // source omits the row rather than printing a guess.
      ["Source", sourceDisplay ?? ""],
    ];

    yield* output.raw(renderComputeDetails(details));

    if (record.instances === undefined && record.instancesError !== undefined) {
      yield* output.raw(`Instance counts could not be read: ${record.instancesError}\n`, "stderr");
    }
    // Not while it is being torn down: deletion is asynchronous, so a push here
    // races the tombstone or resurrects the very compute the user is removing.
    if (record.buildState === "failed" && record.deleting !== true) {
      // Trailer, like every other "what to run next" line in this shell: the
      // command reports a failed build but exits 0, so the trailer flushes.
      yield* emitSuccessTrailer(
        `Fix the issue, then re-run ${aqua(`supabase compute push ${name}${refSuffix}`)}.\n`,
      );
    }
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
