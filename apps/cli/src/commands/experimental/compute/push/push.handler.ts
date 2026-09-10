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
 * `supabase compute push [name...]` — build (when there is code to build) and
 * deploy the compute into the linked project. Registered under `deploy` as an
 * alias, for anyone reaching for the `supabase functions` verb out of habit.
 *
 * The runtime, size, exposure and source directory come from `[compute.<name>]`
 * in `supabase/config.toml`. A directory pushed without ever running `new` gets
 * its runtime guessed from marker files instead — reported, with a nudge to pin
 * it down rather than re-guess on every push.
 *
 * A `dockerfile` compute is tarred and uploaded, and the build happens
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
 * {@link DEFAULT_COMPUTE_INSTANCES}. Never left unset, because every deploy sends
 * a complete spec and an omitted count rescales the compute.
 *
 * No unparseable case to report: the config schema and the flag are both bounded
 * to a non-negative integer before the handler runs.
 */
function resolveInstances(options: {
  readonly recorded: number | undefined;
  readonly override: Option.Option<number>;
}): number {
  return Option.getOrElse(options.override, () => options.recorded ?? DEFAULT_COMPUTE_INSTANCES);
}

/**
 * `--exposure` for one deploy, then the recorded exposure, then
 * {@link DEFAULT_COMPUTE_EXPOSURE}. Never left unset, because every deploy sends a
 * complete spec and an omitted exposure would re-expose a compute somebody had
 * deliberately made private.
 *
 * `--exposure` is a `Flag.choice`, so only a recorded value can be unrecognized
 * — and that is refused rather than coerced, the same way `resolveSize` treats a
 * size it does not know: silently deploying a `private`-typo'd compute as public
 * is the one outcome nobody asked for.
 *
 * The flag decides one deploy and nothing writes it down, so an override the
 * config does not already agree with is reported the way `resolveRuntime`
 * reports a guess: on stderr, naming the line to set. Without it, taking a
 * compute off the internet with `--exposure private` lasts exactly until the next
 * bare `push` puts it back.
 */
const resolveExposure = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly recorded: string | undefined;
  readonly override: Option.Option<ComputeExposure>;
}) {
  if (Option.isSome(options.override)) {
    const chosen = options.override.value;
    // What a later bare `push` would resolve to: the recorded value if the CLI
    // knows it, the default if there is none, and `undefined` for one it cannot
    // read — which is not `chosen` either, so that case is nudged too.
    const withoutTheFlag =
      options.recorded === undefined
        ? DEFAULT_COMPUTE_EXPOSURE
        : parseComputeExposure(options.recorded);
    if (withoutTheFlag !== chosen) {
      const output = yield* Output;
      // stderr, so it never lands inside a payload stdout is carrying — and
      // unguarded by format, like the runtime nudge: a CI run is exactly where
      // a one-deploy exposure quietly reverting matters most.
      yield* output.raw(
        `--exposure ${chosen} applies to this deploy only: supabase/config.toml ${
          options.recorded === undefined
            ? `records no exposure for ${options.name}`
            : `records exposure = "${options.recorded}"`
        }, so the next bare push will not use ${chosen}. ` +
          `Set [compute.${options.name}] exposure = "${chosen}" in supabase/config.toml.\n`,
        "stderr",
      );
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
 * `supabase compute new` is only an answer for a name the config has never
 * heard of — `new` refuses any name already under `[compute.<name>]`, so
 * offering it to a configured compute would answer with a second error. A
 * configured compute is missing a directory, not a config entry, and when the
 * entry pins an explicit `source` the path itself is as likely to be the
 * mistake as the absent directory.
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
 * Deliberately does not point at `supabase compute new`. That command refuses
 * any name already present in `config.toml`, which is where a pushed compute
 * almost always comes from, and it refuses a directory that exists and is not
 * empty — so for both callers here it would answer with a second error rather
 * than a fix. The directory is already in place and already wired up; the only
 * thing missing is the code.
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

  // Checked before the runtime is resolved, not after: with no recorded
  // runtime, `resolveRuntime` classifies the directory and announces what it
  // guessed. Doing that first meant reporting an inference about a path that
  // does not exist, and only then failing on the path.
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
    // Only "no such path" means the compute was never scaffolded. A permission
    // or I/O error on the directory is a different problem with a different
    // fix, and answering it with "there is no compute source, run `compute new`"
    // both misdiagnoses it and points at a directory that already exists — so
    // every other reason propagates as itself.
    const info = yield* fs
      .stat(compute.sourceDir)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "NotFound")
            ? Effect.fail<ComputeSourceMissingError | PlatformError>(sourceMissing)
            : Effect.fail(error),
        ),
      );
    // Something is there, it is just not a directory. Reporting that as "there
    // is no compute source" is false twice over: the path is occupied, and
    // `compute new` refuses a destination that exists and is not a directory,
    // so the scaffold suggestion would answer with a second error.
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

  // Resolved before anything is packaged or uploaded, alongside the runtime and
  // size, so a config that records an exposure this CLI does not know is refused
  // while the refusal is still free.
  const exposure = yield* resolveExposure({
    name,
    recorded: compute.entry?.exposure,
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

    // The guard above counts directory entries, so a tree of nothing but empty
    // subdirectories reaches here and packages to zero files. For a catalog
    // runtime that deploys an image with no handler in it — the exact "nothing
    // to deploy" case that guard exists to refuse.
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

  // Checked whether or not the build was waited on: the verdict can arrive on
  // the deploy response as readily as on a poll. A spec already in `failed` is
  // a refusal the command should report as one, rather than exiting zero on a
  // compute that will never come up.
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

  // Dropped while the build is still running, rather than passed through.
  // `image_version` is optional-but-permitted on the deploy response, so a
  // re-push of a compute that is already serving can echo the image it is
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
    // that reports a completed remote change uses. `renderComputeDetails` drops
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
      // A success trailer rather than an inline stderr line: this is a "what to
      // run next" hint, which `stop`, `bootstrap`, `migration repair` and
      // `gen signing-key` all route through `emitSuccessTrailer` so it prints
      // once at the end of the run instead of scrolling away. It matters here
      // more than for those: pushing several compute would otherwise bury each
      // compute's hint under the next compute's packaging and deploy output.
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
    // Omitted rather than present-and-undefined: `-o toml` hands the payload to
    // smol-toml, which cannot represent undefined and would throw *after* the
    // upload and deploy had completed. Same reason `url` is spread below.
    ...(imageVersion === undefined ? {} : { image_version: imageVersion }),
    build_state: settled.buildState,
    ...(url === undefined ? {} : { url }),
  };
});

/**
 * Names the compute a failed run never got to.
 *
 * The loop stops on the first failure, so everything after it was never
 * attempted — and the error itself only names the compute that broke. Left
 * unsaid, the user has to reconstruct the remainder from argument order, or
 * from the discovery walk's ordering when the push was a bare `push`.
 *
 * Written on stderr in every format, unlike the per-compute announcements: a
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
 * Names the compute whose builds the run left running.
 *
 * Under `--no-wait` a compute is accepted while its build is still in flight, and
 * its follow-up hint goes out as a success trailer. `runCli` drains trailers
 * only on exit code 0 (`shared/cli/run.ts`, `afterSuccess`), so a later compute
 * failing discards every hint the run had queued — including for builds that are
 * still running on the platform, which the failure does nothing to stop.
 *
 * Reported here instead, on the path that actually runs. Same stderr-in-every-
 * format rule as {@link reportUnattempted} and the same reason: a machine-format
 * run is a CI run, and "what is still in flight" is as much a part of the
 * failure's answer as "what never started".
 *
 * Empty on a waiting run, without needing to check the flag: a compute the run
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
 * `supabase compute push [name...]` — deploy the named compute, or every compute
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

  // The ref is resolved outside the finalizers because caching it is one of
  // them; everything that can fail on its own — loading `config.toml`,
  // validating names, discovering compute — belongs inside, so a malformed
  // config still flushes telemetry. Same shape as `config/push`.
  const projectRef = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* loadComputeProject;

    const requested =
      flags.names.length > 0
        ? yield* Effect.forEach(flags.names, validateComputeName)
        : yield* discoverComputeNames(project);

    if (requested.length === 0) {
      return yield* new NoComputeToDeployError({
        detail: `No compute were named, and none were found in ${displayPath(
          path,
          project.projectRoot,
          project.computeDir,
        )}.`,
        suggestion: "Scaffold one with `supabase compute new <name>`.",
      });
    }

    const names = [...new Set(requested)];

    // Before the first deploy, not after the last one: this payload always
    // carries a `compute` array, so `-o env` can never encode it, and finding
    // that out at the end means failing with the remote project already changed.
    yield* rejectComputeEnvOutput();

    const machineOutput = yield* computeMachineOutputRequested();
    // Computed once for the whole run, the way `status` and `delete` do: an
    // explicit `--project-ref` has to survive into every hint this push emits.
    const refSuffix = computeProjectRefSuffix(flags.projectRef);
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
        // Counted, because each compute's package/upload/build takes minutes and
        // the name alone says nothing about how much of the run is left.
        //
        // Text only, on both axes: `machineOutput` tracks `-o`, which leaves
        // `output.format` as `text`, so neither check covers the other. This is
        // progress rather than an outcome, and `--output-format json` asked for
        // a stream of events — unlike the unattempted-compute report below,
        // which every format gets because it says what still needs deploying.
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
        // In flight before what never started: one is a thing the user now has
        // to follow, the other a thing they have to re-run.
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
