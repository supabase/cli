import { Effect, FileSystem, Option, type Schedule } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyRenderWorkerDetails } from "../workers.format.ts";
import {
  legacyEmitWorkersMachineOutput,
  legacyRejectWorkersEnvOutput,
  legacyWorkersMachineOutputRequested,
} from "../workers.output.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { classifyWorkerDir } from "../../../../shared/workers/worker-classify.ts";
import { formatBytes, packageWorkerDirectory } from "../../../../shared/workers/worker-package.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import {
  apiSizeFor,
  DEFAULT_WORKER_INSTANCES,
  DEFAULT_WORKER_SIZE,
  formatApiSize,
  parseWorkerRuntime,
  parseWorkerSize,
  WORKER_RUNTIMES,
  WORKER_SIZES,
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
  UnknownWorkerRuntimeError,
  UnknownWorkerSizeError,
  WorkerBuildFailedError,
  WorkerSourceMissingError,
} from "../../../../shared/workers/workers.errors.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyDescribeWorker,
  legacyDiscoverWorkerNames,
  legacyLoadWorkersProject,
  legacyValidateWorkerName,
  type LegacyWorkersProject,
} from "../workers.shared.ts";
import type { LegacyWorkersPushFlags } from "./push.command.ts";

/**
 * `supabase workers push [name...]` — build (when there is code to build) and
 * deploy the worker into the linked project. Registered under `deploy` as an
 * alias, for anyone reaching for the `supabase functions` verb out of habit.
 *
 * The runtime, size and source directory come from `[workers.<name>]` in
 * `supabase/config.toml`. A directory pushed without ever running `new` gets
 * its runtime guessed from marker files instead — reported, with a nudge to pin
 * it down rather than re-guess on every push.
 *
 * A `dockerfile` worker is tarred and uploaded, and the build happens
 * server-side from that context, never on your machine. A catalog runtime with
 * code takes the same path, with the base image and a copy synthesized in place
 * of your Dockerfile. Every runtime this CLI offers has code to package, so
 * there is no path here that skips the upload.
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

const deployOneWorker = Effect.fnUntraced(function* (input: {
  readonly project: LegacyWorkersProject;
  readonly name: string;
  readonly projectRef: string;
  readonly instances: Option.Option<number>;
  readonly pollSchedule?: Schedule.Schedule<unknown>;
  readonly pollRetrySchedule?: Schedule.Schedule<unknown>;
  /** Suppresses this step's human output when `-o` owns stdout. */
  readonly machineOutput: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;

  const { project, name, projectRef } = input;
  const worker = yield* legacyDescribeWorker(project, name);

  const sourceDisplay = displayPath(project.projectRoot, worker.sourceDir);

  // Checked before the runtime is resolved, not after: with no recorded
  // runtime, `resolveRuntime` classifies the directory and announces what it
  // guessed. Doing that first meant reporting an inference about a path that
  // does not exist, and only then failing on the path.
  {
    const stat = yield* fs.stat(worker.sourceDir).pipe(Effect.option);
    if (Option.isNone(stat) || stat.value.type !== "Directory") {
      return yield* Effect.fail(
        new WorkerSourceMissingError({
          detail: `There is no worker source at ${sourceDisplay}.`,
          suggestion: `Scaffold it with \`supabase workers new ${name}\`.`,
        }),
      );
    }
    // An empty directory packages and deploys perfectly happily, producing an
    // image with nothing in it — a success message for a worker that cannot
    // serve anything. Refuse before uploading rather than after.
    const contents = yield* fs.readDirectory(worker.sourceDir).pipe(Effect.orElseSucceed(() => []));
    if (contents.length === 0) {
      return yield* Effect.fail(
        new WorkerSourceMissingError({
          detail: `${sourceDisplay} is empty, so there is nothing to deploy.`,
          suggestion: `Add your code there, or re-scaffold it with \`supabase workers new ${name} --force\`.`,
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
          suggestion: `Add your code there, or re-scaffold it with \`supabase workers new ${name} --force\`.`,
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
    // Every runtime offered today serves HTTP. A sandbox runtime would need a
    // branch here.
    exposure: "public",
    instances,
  };

  const deploying = yield* output.task("Deploying worker...");
  yield* deployWorker(api, projectRef, name, { spec, contextUploadId }).pipe(
    Effect.tapError(() => deploying.fail()),
  );

  const settled = yield* awaitWorkerBuild(api, projectRef, name, {
    schedule: input.pollSchedule,
    retrySchedule: input.pollRetrySchedule,
    onPoll: (polled) =>
      polled.buildState === "building" ? deploying.message("Building worker...") : Effect.void,
  }).pipe(Effect.tapError(() => deploying.fail()));

  if (settled.buildState === "failed") {
    yield* deploying.clear();
    return yield* Effect.fail(
      new WorkerBuildFailedError({
        detail: `The build for "${name}" failed${
          settled.stateReason === undefined ? "" : `: ${settled.stateReason}`
        }.`,
        suggestion: `Fix the issue, then re-run \`supabase workers push ${name}\`.`,
      }),
    );
  }

  yield* deploying.clear();

  const url =
    settled.spec.exposure === "public"
      ? workerUrl(projectRef, cliConfig.projectHost, name)
      : undefined;

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
        ["Runtime", runtime],
        ["Size", formatApiSize(settled.spec.size)],
        ["Image", settled.imageVersion ?? ""],
        ["Access", settled.spec.exposure],
        ["URL", url ?? ""],
      ]),
    );
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
    ...(settled.imageVersion === undefined ? {} : { image_version: settled.imageVersion }),
    build_state: settled.buildState,
    ...(url === undefined ? {} : { url }),
  };
});

/**
 * `supabase workers push [name...]` — deploy the named workers, or every worker
 * in the project when none are named, mirroring `supabase functions deploy`.
 *
 * Deploys run one at a time rather than concurrently: each is a server-side
 * container build, and interleaving several would both hammer the alpha's
 * per-project capacity and shred the progress output. The first failure stops
 * the run, because a build that failed is usually the thing to fix before
 * spending minutes on the rest.
 */
export const legacyWorkersPush = Effect.fn("legacy.workers.push")(function* (
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
          suggestion: "Scaffold one with `supabase workers new <name>`.",
        }),
      );
    }

    const names = [...new Set(requested)];

    // Before the first deploy, not after the last one: this payload always
    // carries a `workers` array, so `-o env` can never encode it, and finding
    // that out at the end means failing with the remote project already changed.
    yield* legacyRejectWorkersEnvOutput();

    const machineOutput = yield* legacyWorkersMachineOutputRequested();
    const deployed: Array<Record<string, unknown>> = [];
    for (const name of names) {
      if (names.length > 1 && !machineOutput) {
        // stderr, unblanked and labelled, the way `functions deploy` announces
        // each function: a bare name with a leading blank line put a section
        // header into whatever was consuming stdout.
        yield* output.raw(`Deploying Worker: ${legacyAqua(name)}\n`, "stderr");
      }
      deployed.push(
        yield* deployOneWorker({
          project,
          name,
          projectRef,
          instances: flags.instances,
          machineOutput,
          ...(options.pollSchedule === undefined ? {} : { pollSchedule: options.pollSchedule }),
          ...(options.pollRetrySchedule === undefined
            ? {}
            : { pollRetrySchedule: options.pollRetrySchedule }),
        }),
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
