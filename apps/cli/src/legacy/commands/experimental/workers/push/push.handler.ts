import { Effect, FileSystem, Option, Predicate, type Schedule } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Output } from "../../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../../shared/cli/success-trailer.ts";
import { legacyRenderWorkerDetails } from "../workers.format.ts";
import {
  legacyEmitWorkersMachineOutput,
  legacyRejectWorkersEnvOutput,
  legacyWorkersMachineOutputRequested,
  legacyWorkersProjectRefSuffix,
} from "../workers.output.ts";
import { legacyAqua } from "../../../../shared/legacy-colors.ts";
import { LegacyPlatformApi } from "../../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../../config/legacy-cli-settings.service.ts";
import { classifyWorkerDir } from "../../../../../shared/workers/worker-classify.ts";
import {
  formatBytes,
  packageWorkerDirectory,
} from "../../../../../shared/workers/worker-package.ts";
import { displayPath } from "../../../../../shared/workers/worker-paths.ts";
import type { WorkerEntry } from "../../../../../shared/workers/worker-config.ts";
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
} from "../../../../../shared/workers/worker-runtimes.ts";
import { workerUrl } from "../../../../../shared/workers/worker-url.ts";
import {
  awaitWorkerBuild,
  createWorkerUpload,
  deployWorker,
  uploadBuildContext,
  type WorkerDeploySpec,
} from "../../../../../shared/workers/workers-api.ts";
import {
  NoWorkersToDeployError,
  UnknownWorkerExposureError,
  UnknownWorkerRuntimeError,
  UnknownWorkerSizeError,
  WorkerBuildFailedError,
  WorkerSourceMissingError,
} from "../../../../../shared/workers/workers.errors.ts";
import { LegacyProjectRefResolver } from "../../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyDescribeWorker,
  legacyDiscoverWorkerNames,
  legacyLoadWorkersProject,
  legacyValidateWorkerName,
  type LegacyWorkersProject,
} from "../workers.shared.ts";
import type { LegacyWorkersPushFlags } from "./push.command.ts";

/**
 * `supabase experimental workers push [name...]` — build (when there is code to build) and
 * deploy the worker into the linked project. Registered under `deploy` as an
 * alias, for anyone reaching for the `supabase functions` verb out of habit.
 *
 * The runtime, size, exposure and source directory come from `[workers.<name>]`
 * in `supabase/config.toml`. A directory pushed without ever running `new` gets
 * its runtime guessed from marker files instead — reported, with a nudge to pin
 * it down rather than re-guess on every push.
 *
 * A `dockerfile` worker is tarred and uploaded, and the build happens
 * server-side from that context, never on your machine. A catalog runtime with
 * code takes the same path, with the base image and a copy synthesized in place
 * of your Dockerfile. Every runtime this CLI offers has code to package, so
 * there is no path here that skips the upload.
 *
 * The command waits for that server-side build by default, so a plain push
 * reports the build's verdict rather than only that the deploy was accepted.
 * The build routinely runs for minutes, though, which makes every successful
 * deploy as slow as the slowest one — so `--no-wait` returns as soon as the
 * platform accepts the deploy, for an inner-loop redeploy or a CI step that
 * only needs the spec on file.
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
      `Pin it down by adding [workers.${options.name}] runtime = "${classified.runtime}" to supabase/config.toml.\n`,
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
 * {@link DEFAULT_WORKER_INSTANCES}. Never left unset, because every deploy sends
 * a complete spec and an omitted count rescales the worker.
 *
 * No unparseable case to report: the config schema and the flag are both bounded
 * to a non-negative integer before the handler runs.
 */
function resolveInstances(options: {
  readonly recorded: number | undefined;
  readonly override: Option.Option<number>;
}): number {
  return Option.getOrElse(options.override, () => options.recorded ?? DEFAULT_WORKER_INSTANCES);
}

/**
 * `--exposure` for one deploy, then the recorded exposure, then
 * {@link DEFAULT_WORKER_EXPOSURE}. Never left unset, because every deploy sends a
 * complete spec and an omitted exposure would re-expose a worker somebody had
 * deliberately made private.
 *
 * `--exposure` is a `Flag.choice`, so only a recorded value can be unrecognized
 * — and that is refused rather than coerced, the same way `resolveSize` treats a
 * size it does not know: silently deploying a `private`-typo'd worker as public
 * is the one outcome nobody asked for.
 */
const resolveExposure = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly recorded: string | undefined;
  readonly override: Option.Option<WorkerExposure>;
}) {
  if (Option.isSome(options.override)) {
    return options.override.value;
  }
  if (options.recorded === undefined) {
    return DEFAULT_WORKER_EXPOSURE;
  }
  const recorded = parseWorkerExposure(options.recorded);
  if (recorded === undefined) {
    return yield* Effect.fail(
      new UnknownWorkerExposureError({
        // A blank value gets its own sentence: `an unknown exposure ""` reads
        // like a parser quirk, when what actually happened is that the key is
        // there and says nothing.
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
 * `supabase experimental workers new` is only an answer for a name the config has never
 * heard of — `new` refuses any name already under `[workers.<name>]`, so
 * offering it to a configured worker would answer with a second error. A
 * configured worker is missing a directory, not a config entry, and when the
 * entry pins an explicit `source` the path itself is as likely to be the
 * mistake as the absent directory.
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
 * Deliberately does not point at `supabase experimental workers new`. That command refuses
 * any name already present in `config.toml`, which is where a pushed worker
 * almost always comes from, and it refuses a directory that exists and is not
 * empty — so for both callers here it would answer with a second error rather
 * than a fix. The directory is already in place and already wired up; the only
 * thing missing is the code.
 */
function addYourCode(sourceDisplay: string): string {
  return `Add your worker's code to ${sourceDisplay}, then run this command again.`;
}

const deployOneWorker = Effect.fnUntraced(function* (input: {
  readonly project: LegacyWorkersProject;
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
  const api = yield* LegacyPlatformApi;
  const settings = yield* LegacyCliSettings;

  const { project, name, projectRef } = input;
  const worker = yield* legacyDescribeWorker(project, name);

  const sourceDisplay = displayPath(project.projectRoot, worker.sourceDir);

  // Checked before the runtime is resolved, not after: with no recorded
  // runtime, `resolveRuntime` classifies the directory and announces what it
  // guessed. Doing that first meant reporting an inference about a path that
  // does not exist, and only then failing on the path.
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
    // Only "no such path" means the worker was never scaffolded. A permission
    // or I/O error on the directory is a different problem with a different
    // fix, and answering it with "there is no worker source, run `workers new`"
    // both misdiagnoses it and points at a directory that already exists — so
    // every other reason propagates as itself.
    const info = yield* fs
      .stat(worker.sourceDir)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "NotFound")
            ? Effect.fail<WorkerSourceMissingError | PlatformError>(sourceMissing)
            : Effect.fail(error),
        ),
      );
    // Something is there, it is just not a directory. Reporting that as "there
    // is no worker source" is false twice over: the path is occupied, and
    // `workers new` refuses a destination that exists and is not a directory,
    // so the scaffold suggestion would answer with a second error.
    if (info.type !== "Directory") {
      return yield* Effect.fail(
        new WorkerSourceMissingError({
          detail: `${sourceDisplay} is not a directory.`,
          suggestion: `Replace it with a directory holding your worker's code, then run this command again.`,
        }),
      );
    }
    // An empty directory packages and deploys perfectly happily, producing an
    // image with nothing in it — a success message for a worker that cannot
    // serve anything. Refuse before uploading rather than after.
    //
    // Read errors propagate rather than reading as empty: a directory the CLI
    // cannot open is not a directory with nothing in it, and the two want
    // opposite things from the user.
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

  // Size: whatever `new --size` recorded, else the alpha envelope's own
  // default. Never left unset, because a worker that is actually running always
  // has some concrete size — and never silently coerced, because a size the CLI
  // does not recognize is a config mistake worth naming.
  const size = yield* resolveSize({ name, recorded: worker.entry?.size });

  const instances = resolveInstances({
    recorded: worker.entry?.instances,
    override: input.instances,
  });

  // Resolved before anything is packaged or uploaded, alongside the runtime and
  // size, so a config that records an exposure this CLI does not know is refused
  // while the refusal is still free.
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

    // The guard above counts directory entries, so a tree of nothing but empty
    // subdirectories reaches here and packages to zero files. For a catalog
    // runtime that deploys an image with no handler in it — the exact "nothing
    // to deploy" case that guard exists to refuse.
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
  // The response to the deploy itself is the last thing this command can learn
  // without waiting: the platform answers it only after accepting the spec and
  // the uploaded context, and it carries the accepted spec back. Everything
  // after this point is the server-side container build.
  const accepted = yield* deployWorker(api, projectRef, name, { spec, contextUploadId }).pipe(
    Effect.tapError(() => deploying.fail()),
  );

  // Polled only when the deploy response left the build unresolved.
  // `V2DeployAWorkerOutput` permits a terminal `active` or `failed` on the
  // deploy itself, and that verdict is this deploy's — a fresh `GET` can only
  // contradict it: `awaitWorkerBuild` reads a post-deploy 404 as "still
  // building", so an already-`failed` deploy could burn the whole poll budget
  // and surface as a timeout, and a concurrent deployment could answer with a
  // state that belongs to someone else's build.
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

  // Checked whether or not the build was waited on: the verdict can arrive on
  // the deploy response as readily as on a poll. A spec already in `failed` is
  // a refusal the command should report as one, rather than exiting zero on a
  // worker that will never come up.
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

  // Dropped while the build is still running, rather than passed through.
  // `image_version` is optional-but-permitted on the deploy response, so a
  // re-push of a worker that is already serving can echo the image it is
  // serving *now* — the previous build's, not this one's. Rendered beside
  // `State building` that names an image this deploy did not produce, and a
  // script reading `image_version` next to `build_state: "building"` would take
  // it for the new one. Only reachable under `--no-wait`; the default polls
  // until the build leaves `building`, so `settled` carries the real image.
  const imageVersion = settled.buildState === "building" ? undefined : settled.imageVersion;

  // Suppressed when `-o` is in play: the payload owns stdout, and these lines
  // would land in the middle of it.
  if (output.format === "text" && !input.machineOutput) {
    // Declarative line first, then the details — the shape every other command
    // that reports a completed remote change uses. `legacyRenderWorkerDetails` drops
    // empty-valued rows, so optional fields need no conditional spreads.
    yield* output.raw(
      `Deployed Worker ${legacyAqua(name, process.stdout)} to project ${projectRef}\n`,
    );
    yield* output.raw(
      legacyRenderWorkerDetails([
        // Labelled `State`, and placed first, the way `workers status` renders
        // the same field: under `--no-wait` it is the one row that says the
        // worker is not serving yet, so it should not be hunted for at the
        // bottom of the block.
        ["State", settled.buildState],
        ["Runtime", runtime],
        ["Size", formatApiSize(settled.spec.size)],
        // Empty under `--no-wait`: this deploy's image does not exist until the
        // build produces one, and `legacyRenderWorkerDetails` drops an
        // empty-valued row.
        ["Image", imageVersion ?? ""],
        ["Access", settled.spec.exposure],
        ["URL", url ?? ""],
      ]),
    );
    if (settled.buildState === "building") {
      // A success trailer rather than an inline stderr line: this is a "what to
      // run next" hint, which `stop`, `bootstrap`, `migration repair` and
      // `gen signing-key` all route through `emitSuccessTrailer` so it prints
      // once at the end of the run instead of scrolling away. It matters here
      // more than for those: pushing several workers would otherwise bury each
      // worker's hint under the next worker's packaging and deploy output.
      //
      // One short sentence per line, with the command aqua'd the way every
      // other follow-up hint in this shell writes them. The single wrapped
      // paragraph this replaced re-flowed differently at every terminal width
      // and buried the command mid-sentence.
      //
      // No "drop `--no-wait` next time" line to go with it: reaching here means
      // the caller asked not to wait, so the only thing left to tell them is
      // where the build's verdict will show up.
      yield* emitSuccessTrailer(
        `\nYour build was submitted successfully.\n` +
          `Run ${legacyAqua(`supabase experimental workers status ${name}${input.refSuffix}`)} to check on it.\n`,
      );
    }
  }

  return {
    worker_name: name,
    runtime,
    size: settled.spec.size,
    exposure: settled.spec.exposure,
    instances: settled.spec.instances,
    // Omitted rather than present-and-undefined: `-o toml` hands the payload to
    // smol-toml, which cannot represent undefined and would throw *after* the
    // upload and deploy had completed. Same reason `url` is spread below.
    ...(imageVersion === undefined ? {} : { image_version: imageVersion }),
    build_state: settled.buildState,
    ...(url === undefined ? {} : { url }),
  };
});

/**
 * Names the workers a failed run never got to.
 *
 * The loop stops on the first failure, so everything after it was never
 * attempted — and the error itself only names the worker that broke. Left
 * unsaid, the user has to reconstruct the remainder from argument order, or
 * from the discovery walk's ordering when the push was a bare `push`.
 *
 * Written on stderr in every format, unlike the per-worker announcements: a
 * machine-format run is a CI run, which is exactly where nobody is watching the
 * loop and "what still needs deploying" is the question the failure raises.
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
 * Names the workers whose builds the run left running.
 *
 * Under `--no-wait` a worker is accepted while its build is still in flight, and
 * its follow-up hint goes out as a success trailer. `runCli` drains trailers
 * only on exit code 0 (`shared/cli/run.ts`, `afterSuccess`), so a later worker
 * failing discards every hint the run had queued — including for builds that are
 * still running on the platform, which the failure does nothing to stop.
 *
 * Reported here instead, on the path that actually runs. Same stderr-in-every-
 * format rule as {@link reportUnattempted} and the same reason: a machine-format
 * run is a CI run, and "what is still in flight" is as much a part of the
 * failure's answer as "what never started".
 *
 * Empty on a waiting run, without needing to check the flag: a worker the run
 * waited for has left `building` by the time it returns.
 */
const reportStillBuilding = Effect.fnUntraced(function* (building: ReadonlyArray<string>) {
  if (building.length === 0) {
    return;
  }
  const output = yield* Output;
  yield* output.raw(`Still building: ${building.join(", ")}\n`, "stderr");
});

/**
 * `supabase experimental workers push [name...]` — deploy the named workers, or every worker
 * in the project when none are named, mirroring `supabase functions deploy`.
 *
 * Deploys run one at a time rather than concurrently: each is a server-side
 * container build, and interleaving several would both hammer the alpha's
 * per-project capacity and shred the progress output. The first failure stops
 * the run, because a build that failed is usually the thing to fix before
 * spending minutes on the rest.
 *
 * Under `--no-wait` that serialization only covers the package/upload/deploy
 * legs; the builds themselves then run concurrently on the platform, which is
 * what the caller asked for by opting out of the wait.
 */
export const legacyWorkersPush = Effect.fn("legacy.experimental.workers.push")(function* (
  flags: LegacyWorkersPushFlags,
  options: {
    readonly pollSchedule?: Schedule.Schedule<unknown>;
    readonly pollRetrySchedule?: Schedule.Schedule<unknown>;
  } = {},
) {
  const output = yield* Output;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // The ref is resolved outside the finalizers because caching it is one of
  // them; everything that can fail on its own — loading `config.toml`,
  // validating names, discovering workers — belongs inside, so a malformed
  // config still flushes telemetry. Same shape as `config/push`.
  const projectRef = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* legacyLoadWorkersProject();

    const requested =
      flags.names.length > 0
        ? yield* Effect.forEach(flags.names, legacyValidateWorkerName)
        : yield* legacyDiscoverWorkerNames(project);

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
    // carries a `workers` array, so `-o env` can never encode it, and finding
    // that out at the end means failing with the remote project already changed.
    yield* legacyRejectWorkersEnvOutput();

    const machineOutput = yield* legacyWorkersMachineOutputRequested();
    // Computed once for the whole run, the way `status` and `delete` do: an
    // explicit `--project-ref` has to survive into every hint this push emits.
    const refSuffix = legacyWorkersProjectRefSuffix(flags.projectRef);
    const deployed: Array<Record<string, unknown>> = [];
    // Accepted, but not finished: their builds outlive a failure further down
    // the loop, so the failure path has to name them. See `reportStillBuilding`.
    const stillBuilding: Array<string> = [];
    for (const [index, name] of names.entries()) {
      if (names.length > 1 && !machineOutput && output.format === "text") {
        // stderr, unblanked and labelled, the way `functions deploy` announces
        // each function: a bare name with a leading blank line put a section
        // header into whatever was consuming stdout.
        //
        // Counted, because each worker's package/upload/build takes minutes and
        // the name alone says nothing about how much of the run is left.
        //
        // Text only, on both axes: `machineOutput` tracks `-o`, which leaves
        // `output.format` as `text`, so neither check covers the other. This is
        // progress rather than an outcome, and `--output-format json` asked for
        // a stream of events — unlike the unattempted-workers report below,
        // which every format gets because it says what still needs deploying.
        yield* output.raw(
          `Deploying Worker ${index + 1}/${names.length}: ${legacyAqua(name)}\n`,
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
        // In flight before what never started: one is a thing the user now has
        // to follow, the other a thing they have to re-run.
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
          .map((name) => legacyAqua(name, process.stdout))
          .join(", ")}\n`,
      );
    }

    const payload = { project_ref: projectRef, workers: deployed };

    // `-o` asks for a machine-readable stdout, so nothing human may be written
    // to it — `output.success` logs to stdout in text mode.
    if (yield* legacyEmitWorkersMachineOutput(payload)) {
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
