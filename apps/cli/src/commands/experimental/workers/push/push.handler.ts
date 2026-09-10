import { Effect, FileSystem, Option, Predicate, type Schedule } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { renderWorkerDetails } from "../workers.format.ts";
import {
  emitWorkersMachineOutput,
  rejectWorkersEnvOutput,
  workersMachineOutputRequested,
  workersProjectRefSuffix,
} from "../workers.output.ts";
import { aqua } from "../../../../command-internal/colors.ts";
import { CommandPlatformApi } from "../../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { classifyWorkerDir } from "../../../../shared/workers/worker-classify.ts";
import { formatBytes, packageWorkerDirectory } from "../../../../shared/workers/worker-package.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import type { WorkerEntry } from "../../../../shared/workers/worker-config.ts";
import {
  apiSizeFor,
  DEFAULT_WORKER_EXPOSURE,
  DEFAULT_WORKER_INSTANCES,
  DEFAULT_WORKER_SIZE,
  formatApiSize,
  parseWorkerExposure,
  parseWorkerRuntime,
  parseWorkerSize,
  WORKER_EXPOSURES,
  WORKER_RUNTIMES,
  WORKER_SIZES,
  type WorkerExposure,
} from "../../../../shared/workers/worker-runtimes.ts";
import { workerUrl } from "../../../../shared/workers/worker-url.ts";
import {
  awaitWorkerBuild,
  createWorkerUpload,
  deployWorker,
  uploadBuildContext,
  type WorkerDeploySpec,
} from "../../../../shared/workers/workers-api.ts";
import {
  NoWorkersToDeployError,
  UnknownWorkerExposureError,
  UnknownWorkerRuntimeError,
  UnknownWorkerSizeError,
  WorkerBuildFailedError,
  WorkerSourceMissingError,
} from "../../../../shared/workers/workers.errors.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  describeWorker,
  discoverWorkerNames,
  loadWorkersProject,
  validateWorkerName,
  type WorkersProject,
} from "../workers.shared.ts";
import type { WorkersPushFlags } from "./push.command.ts";

/**
 * `supabase experimental workers push [name...]` — deploys the named workers
 * (or every worker, if none are named), reading runtime, size, exposure, and
 * source from `[workers.<name>]`; an unrecorded runtime is guessed and
 * reported. Builds run server-side from an uploaded context and are waited on
 * by default; `--no-wait` returns once the deploy is accepted.
 */

const resolveRuntime = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly recorded: string | undefined;
  readonly sourceDir: string;
}) {
  if (options.recorded !== undefined) {
    const recorded = parseWorkerRuntime(options.recorded);
    if (recorded === undefined) {
      return yield* Effect.fail(
        new UnknownWorkerRuntimeError({
          detail: `supabase/config.toml records an unknown runtime "${options.recorded}" for "${options.name}".`,
          suggestion: `Set [workers.${options.name}] runtime to one of: ${WORKER_RUNTIMES.join(", ")}.`,
        }),
      );
    }
    return recorded;
  }

  const output = yield* Output;
  const classified = yield* classifyWorkerDir(options.sourceDir);
  // A guess the user should pin down: stderr, so it never lands inside a
  // payload stdout is carrying.
  yield* output.raw(
    `No runtime configured for ${options.name}: guessed ${classified.runtime} (${classified.reason}). ` +
      `Set [workers.${options.name}] runtime = "${classified.runtime}" in supabase/config.toml.\n`,
    "stderr",
  );
  return classified.runtime;
});

const resolveSize = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly recorded: string | undefined;
}) {
  if (options.recorded === undefined) {
    return DEFAULT_WORKER_SIZE;
  }
  const recorded = parseWorkerSize(options.recorded);
  if (recorded === undefined) {
    return yield* Effect.fail(
      new UnknownWorkerSizeError({
        detail: `supabase/config.toml records an unknown size "${options.recorded}" for "${options.name}".`,
        suggestion: `Set [workers.${options.name}] size to one of: ${WORKER_SIZES.join(", ")}.`,
      }),
    );
  }
  return recorded;
});

/**
 * `--instances` for one deploy, then the recorded count, then
 * {@link DEFAULT_WORKER_INSTANCES}. Never left unset, since every deploy sends
 * a complete spec and an omitted count would rescale the worker.
 */
function resolveInstances(options: {
  readonly recorded: number | undefined;
  readonly override: Option.Option<number>;
}): number {
  return Option.getOrElse(options.override, () => options.recorded ?? DEFAULT_WORKER_INSTANCES);
}

/**
 * `--exposure` for one deploy, then the recorded exposure, then
 * {@link DEFAULT_WORKER_EXPOSURE}. Never left unset, since an omitted exposure
 * would re-expose a worker made private. An unrecognized recorded value is
 * refused rather than coerced, and a diverging override is reported on
 * stderr, since it applies to this deploy only and the next bare `push` would
 * otherwise revert it.
 */
const resolveExposure = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly recorded: string | undefined;
  readonly override: Option.Option<WorkerExposure>;
}) {
  if (Option.isSome(options.override)) {
    const chosen = options.override.value;
    // What a later bare `push` would resolve to, so a diverging override can be flagged.
    const withoutTheFlag =
      options.recorded === undefined
        ? DEFAULT_WORKER_EXPOSURE
        : parseWorkerExposure(options.recorded);
    if (withoutTheFlag !== chosen) {
      const output = yield* Output;
      // stderr and every format, so it never lands inside a payload stdout is
      // carrying, and a CI run still sees the exposure quietly reverting.
      yield* output.raw(
        `--exposure ${chosen} applies to this deploy only: supabase/config.toml ${
          options.recorded === undefined
            ? `records no exposure for ${options.name}`
            : `records exposure = "${options.recorded}"`
        }, so the next bare push will not use ${chosen}. ` +
          `Set [workers.${options.name}] exposure = "${chosen}" in supabase/config.toml.\n`,
        "stderr",
      );
    }
    return chosen;
  }
  if (options.recorded === undefined) {
    return DEFAULT_WORKER_EXPOSURE;
  }
  const recorded = parseWorkerExposure(options.recorded);
  if (recorded === undefined) {
    return yield* Effect.fail(
      new UnknownWorkerExposureError({
        // A blank value gets its own sentence rather than reading as a parser quirk.
        detail:
          options.recorded.trim() === ""
            ? `supabase/config.toml records a blank exposure for "${options.name}".`
            : `supabase/config.toml records an unknown exposure "${options.recorded}" for "${options.name}".`,
        suggestion: `Set [workers.${options.name}] exposure to one of: ${WORKER_EXPOSURES.join(", ")}.`,
      }),
    );
  }
  return recorded;
});

/**
 * What to do about a worker whose source directory is not there at all.
 *
 * `workers new` refuses any name already configured, so it isn't an answer
 * here — the worker's directory is missing, not its config entry. When the
 * entry pins an explicit `source`, the path itself may be the mistake.
 */
function missingSourceSuggestion(input: {
  readonly name: string;
  readonly sourceDisplay: string;
  readonly configPath: string;
  readonly entry: WorkerEntry | undefined;
}): string {
  if (input.entry === undefined) {
    return `Scaffold it with \`supabase experimental workers new ${input.name}\`.`;
  }
  if (input.entry.source !== undefined) {
    return `Create ${input.sourceDisplay}, or correct \`source\` under [workers.${input.name}] in ${input.configPath}.`;
  }
  return `Create ${input.sourceDisplay} and add your worker's code, then run this command again.`;
}

/**
 * What to do about a source directory that exists but holds nothing to deploy.
 *
 * Doesn't point at `workers new`: it refuses any configured name and any
 * non-empty directory, so both callers here would get a second error instead
 * of a fix. The directory is already wired up; only the code is missing.
 */
function addYourCode(sourceDisplay: string): string {
  return `Add your worker's code to ${sourceDisplay}, then run this command again.`;
}

const deployOneWorker = Effect.fnUntraced(function* (input: {
  readonly project: WorkersProject;
  readonly name: string;
  readonly projectRef: string;
  /**
   * ` --project-ref <ref>` when the flag supplied the ref, `""` when the link
   * did — the follow-up hint below is copy-pasted verbatim, so it has to carry
   * whatever the user typed to reach this project.
   */
  readonly refSuffix: string;
  readonly instances: Option.Option<number>;
  readonly exposure: Option.Option<WorkerExposure>;
  /** `--no-wait`: return once the deploy is accepted instead of blocking on the build. */
  readonly noWait: boolean;
  readonly pollSchedule?: Schedule.Schedule<unknown>;
  readonly pollRetrySchedule?: Schedule.Schedule<unknown>;
  /** Suppresses this step's human output when `-o` owns stdout. */
  readonly machineOutput: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const settings = yield* CommandSettings;

  const { project, name, projectRef } = input;
  const worker = yield* describeWorker(project, name);

  const sourceDisplay = displayPath(project.projectRoot, worker.sourceDir);

  // Checked before the runtime is resolved: without this, an unrecorded runtime
  // would be classified and announced for a path that doesn't exist.
  {
    const sourceMissing = new WorkerSourceMissingError({
      detail: `There is no worker source at ${sourceDisplay}.`,
      suggestion: missingSourceSuggestion({
        name,
        sourceDisplay,
        configPath: displayPath(project.projectRoot, project.configPath),
        entry: worker.entry,
      }),
    });
    // Only "no such path" means the worker was never scaffolded; every other
    // reason (permission, I/O) propagates as itself rather than misdiagnosing it.
    const info = yield* fs
      .stat(worker.sourceDir)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "NotFound")
            ? Effect.fail<WorkerSourceMissingError | PlatformError>(sourceMissing)
            : Effect.fail(error),
        ),
      );
    // Something is there, it's just not a directory — reporting "no worker
    // source" would be false, and the path is occupied besides.
    if (info.type !== "Directory") {
      return yield* Effect.fail(
        new WorkerSourceMissingError({
          detail: `${sourceDisplay} is not a directory.`,
          suggestion: `Replace it with a directory holding your worker's code, then run this command again.`,
        }),
      );
    }
    // An empty directory packages and deploys happily, producing an image with
    // nothing in it — refused here rather than after the upload. A read error
    // propagates rather than reading as empty, since the two want opposite fixes.
    const contents = yield* fs.readDirectory(worker.sourceDir);
    if (contents.length === 0) {
      return yield* Effect.fail(
        new WorkerSourceMissingError({
          detail: `${sourceDisplay} is empty, so there is nothing to deploy.`,
          suggestion: addYourCode(sourceDisplay),
        }),
      );
    }
  }

  const runtime = yield* resolveRuntime({
    name,
    recorded: worker.entry?.runtime,
    sourceDir: worker.sourceDir,
  });

  // Never left unset, since a running worker always has a concrete size, and
  // never silently coerced, since an unrecognized size is a config mistake worth naming.
  const size = yield* resolveSize({ name, recorded: worker.entry?.size });

  const instances = resolveInstances({
    recorded: worker.entry?.instances,
    override: input.instances,
  });

  // Resolved before anything is packaged or uploaded, so an unrecognized
  // exposure is refused while the refusal is still free.
  const exposure = yield* resolveExposure({
    name,
    recorded: worker.entry?.exposure,
    override: input.exposure,
  });

  let contextUploadId: string;
  {
    const packaging = yield* output.task("Packaging worker...");
    const packaged = yield* packageWorkerDirectory(worker.sourceDir).pipe(
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
      return yield* Effect.fail(
        new WorkerSourceMissingError({
          detail: `${sourceDisplay} holds no files to deploy, only empty directories.`,
          suggestion: addYourCode(sourceDisplay),
        }),
      );
    }

    const uploading = yield* output.task("Uploading build context...");
    const slot = yield* createWorkerUpload(api, projectRef, name).pipe(
      Effect.tapError(() => uploading.fail()),
    );
    yield* uploadBuildContext(slot, packaged.archive).pipe(Effect.tapError(() => uploading.fail()));
    yield* uploading.clear();
    yield* output.raw("Uploaded build context.\n", "stderr");
    contextUploadId = slot.uploadId;
  }

  const spec: WorkerDeploySpec = {
    // A plain Dockerfile build has no catalog runtime to name; the uploaded
    // context carries its own Dockerfile and is built as-is.
    ...(runtime === "dockerfile" ? {} : { runtime }),
    size: apiSizeFor(size),
    exposure,
    instances,
  };

  const deploying = yield* output.task("Deploying worker...");
  // The last thing this command can learn without waiting: the platform answers
  // the deploy only after accepting the spec and context, carrying it back.
  const accepted = yield* deployWorker(api, projectRef, name, { spec, contextUploadId }).pipe(
    Effect.tapError(() => deploying.fail()),
  );

  // Polled only when the deploy response left the build unresolved: a fresh GET
  // can only contradict that verdict, since `awaitWorkerBuild` reads a
  // post-deploy 404 as "still building" — polling an already-`failed` deploy
  // could burn the whole budget and surface as a timeout instead.
  const settled =
    input.noWait || accepted.buildState !== "building"
      ? accepted
      : yield* awaitWorkerBuild(api, projectRef, name, {
          schedule: input.pollSchedule,
          retrySchedule: input.pollRetrySchedule,
          refSuffix: input.refSuffix,
          onPoll: (polled) =>
            polled.buildState === "building"
              ? deploying.message("Building worker...")
              : Effect.void,
        }).pipe(Effect.tapError(() => deploying.fail()));

  // Checked regardless of whether the build was waited on: the verdict can
  // arrive on the deploy response as readily as on a poll.
  if (settled.buildState === "failed") {
    yield* deploying.clear();
    return yield* Effect.fail(
      new WorkerBuildFailedError({
        detail: `The build for "${name}" failed${
          settled.stateReason === undefined ? "" : `: ${settled.stateReason}`
        }.`,
        suggestion: `Fix the issue, then re-run \`supabase experimental workers push ${name}${input.refSuffix}\`.`,
      }),
    );
  }

  yield* deploying.clear();

  const url =
    settled.spec.exposure === "public"
      ? workerUrl(projectRef, settings.projectHost, name)
      : undefined;

  // Dropped while still building: `image_version` on the deploy response can
  // echo a worker's previously serving image, not this deploy's, and a script
  // reading it beside `build_state: "building"` would mistake it for the new
  // one. Only reachable under `--no-wait` — the default polls until it settles.
  const imageVersion = settled.buildState === "building" ? undefined : settled.imageVersion;

  // Suppressed when `-o` is in play: the payload owns stdout, and these lines
  // would land in the middle of it.
  if (output.format === "text" && !input.machineOutput) {
    // Declarative line first, then the details. `renderWorkerDetails` drops
    // empty-valued rows, so optional fields need no conditional spreads.
    yield* output.raw(`Deployed Worker ${aqua(name, process.stdout)} to project ${projectRef}\n`);
    yield* output.raw(
      renderWorkerDetails([
        // Placed first: under `--no-wait` this is the one row saying the worker
        // isn't serving yet, so it shouldn't be hunted for at the bottom.
        ["State", settled.buildState],
        ["Runtime", runtime],
        ["Size", formatApiSize(settled.spec.size)],
        // Empty under `--no-wait`, since this deploy's image doesn't exist yet.
        ["Image", imageVersion ?? ""],
        ["Access", settled.spec.exposure],
        ["URL", url ?? ""],
      ]),
    );
    if (settled.buildState === "building") {
      // A success trailer, not an inline stderr line, so pushing several workers
      // doesn't bury each hint under the next worker's output. One short
      // sentence per line, since a single wrapped paragraph re-flowed
      // unpredictably and buried the command mid-sentence.
      yield* emitSuccessTrailer(
        `\nYour build was submitted successfully.\n` +
          `Run ${aqua(`supabase experimental workers status ${name}${input.refSuffix}`)} to check on it.\n`,
      );
    }
  }

  return {
    worker_name: name,
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
 * Names the workers a failed run never got to. The loop stops on the first
 * failure, and the error itself only names the worker that broke, so this is
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
 * Names the workers whose builds the run left running. Under `--no-wait` a
 * worker's follow-up hint goes out as a success trailer, but trailers only
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
 * `supabase experimental workers push [name...]` — deploys the named workers,
 * or every worker when none are named.
 *
 * Deploys run one at a time: each is a server-side container build, and several
 * at once would hammer the alpha's per-project capacity. The first failure
 * stops the run; under `--no-wait`, only the package/upload/deploy legs are
 * serialized — the builds themselves run concurrently.
 */
export const workersPush = Effect.fn("experimental.workers.push")(function* (
  flags: WorkersPushFlags,
  options: {
    readonly pollSchedule?: Schedule.Schedule<unknown>;
    readonly pollRetrySchedule?: Schedule.Schedule<unknown>;
  } = {},
) {
  const output = yield* Output;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // Resolved here, outside the block below, since caching it is one of that
  // block's own finalizers — everything else that can fail belongs inside so
  // those failures still flush telemetry.
  const projectRef = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* loadWorkersProject();

    const requested =
      flags.names.length > 0
        ? yield* Effect.forEach(flags.names, validateWorkerName)
        : yield* discoverWorkerNames(project);

    if (requested.length === 0) {
      return yield* Effect.fail(
        new NoWorkersToDeployError({
          detail: `No workers were named, and none were found in ${displayPath(
            project.projectRoot,
            project.workersDir,
          )}.`,
          suggestion: "Scaffold one with `supabase experimental workers new <name>`.",
        }),
      );
    }

    const names = [...new Set(requested)];

    // Before the first deploy, not after the last one: this payload always
    // carries a `workers` array, which `-o env` can never encode, so finding
    // that out at the end would mean failing with the remote project already changed.
    yield* rejectWorkersEnvOutput();

    const machineOutput = yield* workersMachineOutputRequested();
    // Computed once for the whole run: an explicit `--project-ref` has to
    // survive into every hint this push emits.
    const refSuffix = workersProjectRefSuffix(flags.projectRef);
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
          `Deploying Worker ${index + 1}/${names.length}: ${aqua(name)}\n`,
          "stderr",
        );
      }
      const worker = yield* deployOneWorker({
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
      deployed.push(worker);
      if (worker.build_state === "building") {
        stillBuilding.push(name);
      }
    }

    // Only for a run that deployed several: one worker already said so itself,
    // and repeating it as a summary reads like a second deploy.
    if (names.length > 1 && !machineOutput && output.format === "text") {
      yield* output.raw(
        `Deployed ${names.length} Workers to project ${projectRef}: ${names
          .map((name) => aqua(name, process.stdout))
          .join(", ")}\n`,
      );
    }

    const payload = { project_ref: projectRef, workers: deployed };

    // `-o` asks for a machine-readable stdout, so nothing human may be written
    // to it — `output.success` logs to stdout in text mode.
    if (yield* emitWorkersMachineOutput(payload)) {
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
