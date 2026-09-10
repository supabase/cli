import { Effect, FileSystem, Option, Path, Predicate, type Schedule } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { renderComputeDetails } from "../compute.format.ts";
import {
  emitComputeMachineOutput,
  rejectComputeEnvOutput,
  computeMachineOutputRequested,
  computeProjectRefSuffix,
} from "../compute.output.ts";
import { aqua } from "../../../../command-internal/colors.ts";
import { CommandPlatformApi } from "../../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { classifyComputeDir } from "../../../../shared/compute/compute-classify.ts";
import {
  formatBytes,
  packageComputeDirectory,
} from "../../../../shared/compute/compute-package.ts";
import { displayPath } from "../../../../shared/compute/compute-paths.ts";
import type { ComputeEntry } from "../../../../shared/compute/compute-config.ts";
import {
  apiSizeFor,
  DEFAULT_COMPUTE_EXPOSURE,
  DEFAULT_COMPUTE_INSTANCES,
  DEFAULT_COMPUTE_SIZE,
  formatApiSize,
  parseComputeExposure,
  parseComputeRuntime,
  parseComputeSize,
  COMPUTE_EXPOSURES,
  COMPUTE_RUNTIMES,
  COMPUTE_SIZES,
  type ComputeExposure,
} from "../../../../shared/compute/compute-runtimes.ts";
import { computeUrl } from "../../../../shared/compute/compute-url.ts";
import {
  awaitComputeBuild,
  createComputeUpload,
  deployCompute,
  uploadBuildContext,
  type ComputeDeploySpec,
} from "../../../../shared/compute/compute-api.ts";
import {
  NoComputeToDeployError,
  UnknownComputeExposureError,
  UnknownComputeRuntimeError,
  UnknownComputeSizeError,
  ComputeBuildFailedError,
  ComputeSourceMissingError,
  MissingComputeExposureError,
} from "../../../../shared/compute/compute.errors.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  describeCompute,
  discoverComputeNames,
  loadComputeProject,
  validateComputeName,
  type ComputeProject,
} from "../compute.shared.ts";
import type { ComputePushFlags } from "./push.command.ts";

/**
 * `supabase compute push [name...]` — deploys the named compute
 * (or every compute, if none are named), reading runtime, size, exposure, and
 * source from `[compute.<name>]`; an unrecorded runtime is guessed and
 * reported. Builds run server-side from an uploaded context and are waited on
 * by default; `--no-wait` returns once the deploy is accepted.
 */

const resolveRuntime = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly recorded: string | undefined;
  readonly sourceDir: string;
}) {
  if (options.recorded !== undefined) {
    const recorded = parseComputeRuntime(options.recorded);
    if (recorded === undefined) {
      return yield* new UnknownComputeRuntimeError({
        detail: `supabase/config.toml records an unknown runtime "${options.recorded}" for "${options.name}".`,
        suggestion: `Set [compute.${options.name}] runtime to one of: ${COMPUTE_RUNTIMES.join(", ")}.`,
      });
    }
    return recorded;
  }

  const output = yield* Output;
  const classified = yield* classifyComputeDir(options.sourceDir);
  // A guess the user should pin down: stderr, so it never lands inside a
  // payload stdout is carrying.
  yield* output.raw(
    `No runtime configured for ${options.name}: guessed ${classified.runtime} (${classified.reason}). ` +
      `Set [compute.${options.name}] runtime = "${classified.runtime}" in supabase/config.toml.\n`,
    "stderr",
  );
  return classified.runtime;
});

const resolveSize = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly recorded: string | undefined;
}) {
  if (options.recorded === undefined) {
    return DEFAULT_COMPUTE_SIZE;
  }
  const recorded = parseComputeSize(options.recorded);
  if (recorded === undefined) {
    return yield* new UnknownComputeSizeError({
      detail: `supabase/config.toml records an unknown size "${options.recorded}" for "${options.name}".`,
      suggestion: `Set [compute.${options.name}] size to one of: ${COMPUTE_SIZES.join(", ")}.`,
    });
  }
  return recorded;
});

/**
 * `--instances` for one deploy, then the recorded count, then
 * {@link DEFAULT_COMPUTE_INSTANCES}. Never left unset, since every deploy sends
 * a complete spec and an omitted count would rescale the compute.
 */
function resolveInstances(options: {
  readonly recorded: number | undefined;
  readonly override: Option.Option<number>;
}): number {
  return Option.getOrElse(options.override, () => options.recorded ?? DEFAULT_COMPUTE_INSTANCES);
}

/**
 * `--exposure` for one deploy, then the recorded exposure, then
 * {@link DEFAULT_COMPUTE_EXPOSURE}. Never left unset, since an omitted exposure
 * would re-expose a compute made private. An unrecognized recorded value is
 * refused rather than coerced, and a diverging override is reported on
 * stderr, since it applies to this deploy only and the next bare `push` would
 * otherwise revert it.
 */
const resolveExposure = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly recorded: string | undefined;
  readonly configured: boolean;
  readonly override: Option.Option<ComputeExposure>;
}) {
  if (Option.isSome(options.override)) {
    const chosen = options.override.value;
    // What a later bare `push` would resolve to, so a diverging override can be flagged.
    const withoutTheFlag =
      options.recorded === undefined
        ? DEFAULT_COMPUTE_EXPOSURE
        : parseComputeExposure(options.recorded);
    if (!options.configured || withoutTheFlag !== chosen) {
      const output = yield* Output;
      // stderr, so it never lands inside a payload stdout is carrying — and
      // unguarded by format, like the runtime nudge: a CI run is exactly where
      // a one-deploy exposure quietly reverting matters most.
      const message = options.configured
        ? `--exposure ${chosen} applies to this deploy only: supabase/config.toml ${
            options.recorded === undefined
              ? `records no exposure for ${options.name}`
              : `records exposure = "${options.recorded}"`
          }, so the next bare push will not use ${chosen}. Set [compute.${options.name}] exposure = "${chosen}" in supabase/config.toml.\n`
        : `--exposure ${chosen} is required for an unconfigured source directory. Record it under [compute.${options.name}] exposure for future pushes.\n`;
      yield* output.raw(message, "stderr");
    }
    return chosen;
  }
  if (options.recorded === undefined) {
    return DEFAULT_COMPUTE_EXPOSURE;
  }
  const recorded = parseComputeExposure(options.recorded);
  if (recorded === undefined) {
    return yield* new UnknownComputeExposureError({
      // A blank value gets its own sentence: `an unknown exposure ""` reads
      // like a parser quirk, when what actually happened is that the key is
      // there and says nothing.
      detail:
        options.recorded.trim() === ""
          ? `supabase/config.toml records a blank exposure for "${options.name}".`
          : `supabase/config.toml records an unknown exposure "${options.recorded}" for "${options.name}".`,
      suggestion: `Set [compute.${options.name}] exposure to one of: ${COMPUTE_EXPOSURES.join(", ")}.`,
    });
  }
  return recorded;
});

/**
 * What to do about a compute whose source directory is not there at all.
 *
 * `compute new` refuses any name already configured, so it isn't an answer
 * here — the compute's directory is missing, not its config entry. When the
 * entry pins an explicit `source`, the path itself may be the mistake.
 */
function missingSourceSuggestion(input: {
  readonly name: string;
  readonly sourceDisplay: string;
  readonly configPath: string;
  readonly entry: ComputeEntry | undefined;
}): string {
  if (input.entry === undefined) {
    return `Scaffold it with \`supabase compute new ${input.name}\`.`;
  }
  if (input.entry.source !== undefined) {
    return `Create ${input.sourceDisplay}, or correct \`source\` under [compute.${input.name}] in ${input.configPath}.`;
  }
  return `Create ${input.sourceDisplay} and add your compute's code, then run this command again.`;
}

/**
 * What to do about a source directory that exists but holds nothing to deploy.
 *
 * Doesn't point at `compute new`: it refuses any configured name and any
 * non-empty directory, so both callers here would get a second error instead
 * of a fix. The directory is already wired up; only the code is missing.
 */
function addYourCode(sourceDisplay: string): string {
  return `Add your compute's code to ${sourceDisplay}, then run this command again.`;
}

const deployOneCompute = Effect.fnUntraced(function* (input: {
  readonly project: ComputeProject;
  readonly name: string;
  readonly projectRef: string;
  /**
   * ` --project-ref <ref>` when the flag supplied the ref, `""` when the link
   * did — the follow-up hint below is copy-pasted verbatim, so it has to carry
   * whatever the user typed to reach this project.
   */
  readonly refSuffix: string;
  readonly instances: Option.Option<number>;
  readonly exposure: Option.Option<ComputeExposure>;
  /** `--no-wait`: return once the deploy is accepted instead of blocking on the build. */
  readonly noWait: boolean;
  readonly pollSchedule?: Schedule.Schedule<unknown>;
  readonly pollRetrySchedule?: Schedule.Schedule<unknown>;
  /** Suppresses this step's human output when `-o` owns stdout. */
  readonly machineOutput: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const settings = yield* CommandSettings;

  const { project, name, projectRef } = input;
  const compute = yield* describeCompute(project, name);

  const sourceDisplay = displayPath(path, project.projectRoot, compute.sourceDir);

  // Checked before the runtime is resolved: without this, an unrecorded runtime
  // would be classified and announced for a path that doesn't exist.
  {
    const sourceMissing = new ComputeSourceMissingError({
      detail: `There is no compute source at ${sourceDisplay}.`,
      suggestion: missingSourceSuggestion({
        name,
        sourceDisplay,
        configPath: displayPath(path, project.projectRoot, project.configPath),
        entry: compute.entry,
      }),
    });
    // Only "no such path" means the compute was never scaffolded; every other
    // reason (permission, I/O) propagates as itself rather than misdiagnosing it.
    const info = yield* fs
      .stat(compute.sourceDir)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "NotFound")
            ? Effect.fail<ComputeSourceMissingError | PlatformError>(sourceMissing)
            : Effect.fail(error),
        ),
      );
    // Something is there, it's just not a directory — reporting "no compute
    // source" would be false, and the path is occupied besides.
    if (info.type !== "Directory") {
      return yield* new ComputeSourceMissingError({
        detail: `${sourceDisplay} is not a directory.`,
        suggestion: `Replace it with a directory holding your compute's code, then run this command again.`,
      });
    }
    // An empty directory packages and deploys perfectly happily, producing an
    // image with nothing in it — a success message for a compute that cannot
    // serve anything. Refuse before uploading rather than after.
    //
    // Read errors propagate rather than reading as empty: a directory the CLI
    // cannot open is not a directory with nothing in it, and the two want
    // opposite things from the user.
    const contents = yield* fs.readDirectory(compute.sourceDir);
    if (contents.length === 0) {
      return yield* new ComputeSourceMissingError({
        detail: `${sourceDisplay} is empty, so there is nothing to deploy.`,
        suggestion: addYourCode(sourceDisplay),
      });
    }
  }

  const runtime = yield* resolveRuntime({
    name,
    recorded: compute.entry?.runtime,
    sourceDir: compute.sourceDir,
  });

  // Size: whatever `new --size` recorded, else the alpha envelope's own
  // default. Never left unset, because a compute that is actually running always
  // has some concrete size — and never silently coerced, because a size the CLI
  // does not recognize is a config mistake worth naming.
  const size = yield* resolveSize({ name, recorded: compute.entry?.size });

  const instances = resolveInstances({
    recorded: compute.entry?.instances,
    override: input.instances,
  });

  // Resolved before anything is packaged or uploaded, so an unrecognized
  // exposure is refused while the refusal is still free.
  const exposure = yield* resolveExposure({
    name,
    recorded: compute.entry?.exposure,
    configured: compute.entry !== undefined,
    override: input.exposure,
  });

  let contextUploadId: string;
  {
    const packaging = yield* output.task("Packaging compute...");
    const packaged = yield* packageComputeDirectory(compute.sourceDir).pipe(
      Effect.tapError(() => packaging.fail()),
    );
    yield* packaging.clear();
    yield* output.raw(
      `Packaged ${sourceDisplay} (${packaged.fileCount} files, ${formatBytes(
        packaged.archive.length,
      )}).\n`,
      "stderr",
    );

    // The guard above only counts directory entries, so a tree of nothing but
    // empty subdirectories still reaches here and packages to zero files.
    if (packaged.fileCount === 0) {
      return yield* new ComputeSourceMissingError({
        detail: `${sourceDisplay} holds no files to deploy, only empty directories.`,
        suggestion: addYourCode(sourceDisplay),
      });
    }

    const uploading = yield* output.task("Uploading build context...");
    const slot = yield* createComputeUpload(api, projectRef, name).pipe(
      Effect.tapError(() => uploading.fail()),
    );
    yield* uploadBuildContext(slot, packaged.archive).pipe(Effect.tapError(() => uploading.fail()));
    yield* uploading.clear();
    yield* output.raw("Uploaded build context.\n", "stderr");
    contextUploadId = slot.uploadId;
  }

  const spec: ComputeDeploySpec = {
    // A plain Dockerfile build has no catalog runtime to name; the uploaded
    // context carries its own Dockerfile and is built as-is.
    ...(runtime === "dockerfile" ? {} : { runtime }),
    size: apiSizeFor(size),
    exposure,
    instances,
  };

  const deploying = yield* output.task("Deploying compute...");
  // The response to the deploy itself is the last thing this command can learn
  // without waiting: the platform answers it only after accepting the spec and
  // the uploaded context, and it carries the accepted spec back. Everything
  // after this point is the server-side container build.
  const accepted = yield* deployCompute(api, projectRef, name, { spec, contextUploadId }).pipe(
    Effect.tapError(() => deploying.fail()),
  );

  // Polled only when the deploy response left the build unresolved.
  // `V2DeployAWorkerOutput` permits a terminal `active` or `failed` on the
  // deploy itself, and that verdict is this deploy's — a fresh `GET` can only
  // contradict it: `awaitComputeBuild` reads a post-deploy 404 as "still
  // building", so an already-`failed` deploy could burn the whole poll budget
  // and surface as a timeout, and a concurrent deployment could answer with a
  // state that belongs to someone else's build.
  const settled =
    input.noWait || accepted.buildState !== "building"
      ? accepted
      : yield* awaitComputeBuild(api, projectRef, name, {
          schedule: input.pollSchedule,
          retrySchedule: input.pollRetrySchedule,
          refSuffix: input.refSuffix,
          onPoll: (polled) =>
            polled.buildState === "building"
              ? deploying.message("Building compute...")
              : Effect.void,
        }).pipe(Effect.tapError(() => deploying.fail()));

  // Checked regardless of whether the build was waited on: the verdict can
  // arrive on the deploy response as readily as on a poll.
  if (settled.buildState === "failed") {
    yield* deploying.clear();
    return yield* new ComputeBuildFailedError({
      detail: `The build for "${name}" failed${
        settled.stateReason === undefined ? "" : `: ${settled.stateReason}`
      }.`,
      suggestion: `Fix the issue, then re-run \`supabase compute push ${name}${input.refSuffix}\`.`,
    });
  }

  yield* deploying.clear();

  const url =
    settled.spec.exposure === "public"
      ? computeUrl(projectRef, settings.projectHost, name)
      : undefined;

  // Dropped while still building: `image_version` on the deploy response can
  // echo a compute's previously serving image, not this deploy's, and a script
  // reading it beside `build_state: "building"` would mistake it for the new
  // one. Only reachable under `--no-wait` — the default polls until it settles.
  const imageVersion = settled.buildState === "building" ? undefined : settled.imageVersion;

  // Suppressed when `-o` is in play: the payload owns stdout, and these lines
  // would land in the middle of it.
  if (output.format === "text" && !input.machineOutput) {
    // Declarative line first, then the details. `renderComputeDetails` drops
    // empty-valued rows, so optional fields need no conditional spreads.
    yield* output.raw(`Deployed Compute ${aqua(name, process.stdout)} to project ${projectRef}\n`);
    yield* output.raw(
      renderComputeDetails([
        // Labelled `State`, and placed first, the way `compute status` renders
        // the same field: under `--no-wait` it is the one row that says the
        // compute is not serving yet, so it should not be hunted for at the
        // bottom of the block.
        ["State", settled.buildState],
        ["Runtime", runtime],
        ["Size", formatApiSize(settled.spec.size)],
        // Empty under `--no-wait`: this deploy's image does not exist until the
        // build produces one, and `renderComputeDetails` drops an
        // empty-valued row.
        ["Image", imageVersion ?? ""],
        ["Access", settled.spec.exposure],
        ["URL", url ?? ""],
      ]),
    );
    if (settled.buildState === "building") {
      // A success trailer, not an inline stderr line, so pushing several compute
      // doesn't bury each hint under the next compute's output. One short
      // sentence per line, since a single wrapped paragraph re-flowed
      // unpredictably and buried the command mid-sentence.
      yield* emitSuccessTrailer(
        `\nYour build was submitted successfully.\n` +
          `Run ${aqua(`supabase compute status ${name}${input.refSuffix}`)} to check on it.\n`,
      );
    }
  }

  return {
    compute_name: name,
    runtime,
    size: settled.spec.size,
    exposure: settled.spec.exposure,
    instances: settled.spec.instances,
    // Omitted rather than present-and-undefined: `-o toml` hands this to
    // smol-toml, which can't represent undefined and would throw after the
    // deploy completed. Same reason `url` is spread below.
    ...(imageVersion === undefined ? {} : { image_version: imageVersion }),
    build_state: settled.buildState,
    ...(url === undefined ? {} : { url }),
  };
});

/**
 * Names the compute a failed run never got to. The loop stops on the first
 * failure, and the error itself only names the compute that broke, so this is
 * how the remaining names get reported. Written on stderr in every format,
 * since a machine-format run is a CI run where nobody is watching the loop.
 */
const reportUnattempted = Effect.fnUntraced(function* (skipped: ReadonlyArray<string>) {
  if (skipped.length === 0) {
    return;
  }
  const output = yield* Output;
  // A label rather than a sentence, so it reads the same for one name or six
  // and carries no verb to agree with the count.
  yield* output.raw(`Not attempted: ${skipped.join(", ")}\n`, "stderr");
});

/**
 * Names the compute whose builds the run left running. Under `--no-wait` a
 * compute's follow-up hint goes out as a success trailer, but trailers only
 * drain on exit code 0 — so a later failure would otherwise discard the hint
 * for a build still running on the platform. Reported here instead, on the
 * path that actually runs, using the same stderr-in-every-format rule as
 * {@link reportUnattempted}.
 */
const reportStillBuilding = Effect.fnUntraced(function* (building: ReadonlyArray<string>) {
  if (building.length === 0) {
    return;
  }
  const output = yield* Output;
  yield* output.raw(`Still building: ${building.join(", ")}\n`, "stderr");
});

/**
 * `supabase compute push [name...]` — deploys the named compute,
 * or every compute when none are named.
 *
 * Deploys run one at a time: each is a server-side container build, and several
 * at once would hammer the alpha's per-project capacity. The first failure
 * stops the run; under `--no-wait`, only the package/upload/deploy legs are
 * serialized — the builds themselves run concurrently.
 */
export const computePush = Effect.fn("compute.push")(function* (
  flags: ComputePushFlags,
  options: {
    readonly pollSchedule?: Schedule.Schedule<unknown>;
    readonly pollRetrySchedule?: Schedule.Schedule<unknown>;
  } = {},
) {
  const output = yield* Output;
  const path = yield* Path.Path;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // Resolved here, outside the block below, since caching it is one of that
  // block's own finalizers — everything else that can fail belongs inside so
  // those failures still flush telemetry.
  const projectRef = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* loadComputeProject;

    const requested =
      flags.names.length > 0
        ? yield* Effect.forEach(flags.names, validateComputeName)
        : yield* discoverComputeNames(project);

    if (requested.length === 0) {
      return yield* new NoComputeToDeployError({
        detail: `No Compute services were named, and none were found in ${displayPath(
          path,
          project.projectRoot,
          project.computeDir,
        )}.`,
        suggestion: "Scaffold one with `supabase compute new <name>`.",
      });
    }

    const names = [...new Set(requested)];
    const refSuffix = computeProjectRefSuffix(flags.projectRef);

    if (Option.isNone(flags.exposure)) {
      for (const name of names) {
        if (project.section.compute[name] !== undefined) continue;
        const compute = yield* describeCompute(project, name);
        if (compute.entry === undefined && compute.sourceExists) {
          return yield* new MissingComputeExposureError({
            detail: `No exposure is configured for the unconfigured compute "${name}".`,
            suggestion: `Run \`supabase compute push ${name} --exposure public${refSuffix}\` or \`supabase compute push ${name} --exposure private${refSuffix}\`.`,
          });
        }
      }
    }

    // Before the first deploy, not after the last one: this payload always
    // carries a `compute` array, so `-o env` can never encode it, and finding
    // that out at the end means failing with the remote project already changed.
    yield* rejectComputeEnvOutput();

    const machineOutput = yield* computeMachineOutputRequested();
    const deployed: Array<Record<string, unknown>> = [];
    // Accepted, but not finished: their builds outlive a failure further down
    // the loop, so the failure path has to name them. See `reportStillBuilding`.
    const stillBuilding: Array<string> = [];
    for (const [index, name] of names.entries()) {
      if (names.length > 1 && !machineOutput && output.format === "text") {
        // Progress, not an outcome, so this is text-only on both axes:
        // `machineOutput` tracks `-o` (which leaves `output.format` as `text`),
        // and `--output-format json` asked for a stream of events instead.
        yield* output.raw(
          `Deploying Compute ${index + 1}/${names.length}: ${aqua(name)}\n`,
          "stderr",
        );
      }
      const compute = yield* deployOneCompute({
        project,
        name,
        projectRef,
        refSuffix,
        instances: flags.instances,
        exposure: flags.exposure,
        noWait: flags.noWait,
        machineOutput,
        ...(options.pollSchedule === undefined ? {} : { pollSchedule: options.pollSchedule }),
        ...(options.pollRetrySchedule === undefined
          ? {}
          : { pollRetrySchedule: options.pollRetrySchedule }),
      }).pipe(
        Effect.tapError(() =>
          reportStillBuilding(stillBuilding).pipe(
            Effect.andThen(reportUnattempted(names.slice(index + 1))),
          ),
        ),
      );
      deployed.push(compute);
      if (compute.build_state === "building") {
        stillBuilding.push(name);
      }
    }

    // Only for a run that deployed several: one compute already said so itself,
    // and repeating it as a summary reads like a second deploy.
    if (names.length > 1 && !machineOutput && output.format === "text") {
      yield* output.raw(
        `Deployed ${names.length} Compute to project ${projectRef}: ${names
          .map((name) => aqua(name, process.stdout))
          .join(", ")}\n`,
      );
    }

    const payload = { project_ref: projectRef, compute: deployed };

    // `-o` asks for a machine-readable stdout, so nothing human may be written
    // to it — `output.success` logs to stdout in text mode.
    if (yield* emitComputeMachineOutput(payload)) {
      return;
    }

    if (output.format !== "text") {
      yield* output.success("", payload);
    }
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
