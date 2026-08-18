import { Effect, FileSystem, type Schedule } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { renderWorkerDetails } from "../workers.format.ts";
import {
  legacyEmitWorkersGoOutput,
  legacyWorkersMachineOutputRequested,
} from "../workers.output.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { classifyWorkerDir } from "../../../../shared/workers/worker-classify.ts";
import { formatBytes, packageWorkerDirectory } from "../../../../shared/workers/worker-package.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import {
  apiSizeFor,
  DEFAULT_WORKER_SIZE,
  exposureFor,
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
 * `supabase workers push [name]` — build (when there is code to build) and
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
 * of your Dockerfile. Only `sandbox` skips packaging entirely and runs a
 * pre-built image, so it has no URL.
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
    `No runtime configured for "${options.name}" — guessed ${classified.runtime} (${classified.reason}). ` +
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

const deployOneWorker = Effect.fnUntraced(function* (input: {
  readonly project: LegacyWorkersProject;
  readonly name: string;
  readonly projectRef: string;
  readonly instances: number;
  readonly pollSchedule?: Schedule.Schedule<unknown>;
  /** Suppresses this step's human output when `-o` owns stdout. */
  readonly machineOutput: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;

  const { project, name, projectRef } = input;
  const worker = legacyDescribeWorker(project, name);

  const runtime = yield* resolveRuntime({
    name,
    recorded: worker.entry?.runtime,
    sourceDir: worker.sourceDir,
  });

  // A bare sandbox has no code to package, so it is the one runtime that does
  // not need a source directory on disk at all.
  const needsContext = runtime !== "sandbox";
  const sourceDisplay = displayPath(project.projectRoot, worker.sourceDir);

  if (needsContext) {
    const stat = yield* fs.stat(worker.sourceDir).pipe(Effect.option);
    if (stat._tag === "None" || stat.value.type !== "Directory") {
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

  // Size: whatever `new --size` recorded, else the alpha envelope's own
  // default. Never left unset, because a worker that is actually running always
  // has some concrete size — and never silently coerced, because a size the CLI
  // does not recognize is a config mistake worth naming.
  const size = yield* resolveSize({ name, recorded: worker.entry?.size });

  let contextUploadId: string | undefined;
  if (needsContext) {
    const packaging = yield* output.task(`Packaging ${sourceDisplay}...`);
    const packaged = yield* packageWorkerDirectory(worker.sourceDir).pipe(
      Effect.tapError(() => packaging.fail()),
    );
    yield* packaging.succeed(
      `Packaged ${sourceDisplay} (${packaged.fileCount} files, ${formatBytes(
        packaged.archive.length,
      )}).`,
    );

    const uploading = yield* output.task("Uploading the build context...");
    const slot = yield* createWorkerUpload(api, projectRef, name).pipe(
      Effect.tapError(() => uploading.fail()),
    );
    yield* uploadBuildContext(slot, packaged.archive).pipe(Effect.tapError(() => uploading.fail()));
    yield* uploading.succeed("Uploaded the build context.");
    contextUploadId = slot.uploadId;
  } else {
    yield* output.raw("Bare sandbox — no code is baked in.\n");
  }

  const spec: WorkerDeploySpec = {
    // A plain Dockerfile build has no catalog runtime to name; the uploaded
    // context carries its own Dockerfile and is built as-is.
    ...(runtime === "dockerfile" ? {} : { runtime }),
    size: apiSizeFor(size),
    exposure: exposureFor(runtime),
    instances: input.instances,
  };

  const deploying = yield* output.task(`Deploying "${name}"...`);
  yield* deployWorker(api, projectRef, name, { spec, contextUploadId }).pipe(
    Effect.tapError(() => deploying.fail()),
  );

  const settled = yield* awaitWorkerBuild(api, projectRef, name, {
    schedule: input.pollSchedule,
    onPoll: (polled) =>
      polled.buildState === "building" ? deploying.message(`Building "${name}"...`) : Effect.void,
  }).pipe(Effect.tapError(() => deploying.fail()));

  if (settled.buildState === "failed") {
    yield* deploying.fail(`Deploying "${name}" failed.`);
    return yield* Effect.fail(
      new WorkerBuildFailedError({
        detail: `The build for "${name}" failed${
          settled.stateReason === undefined ? "" : `: ${settled.stateReason}`
        }.`,
        suggestion: `Fix the issue, then re-run \`supabase workers push ${name}\`.`,
      }),
    );
  }

  yield* deploying.succeed(`Deployed "${name}".`);

  const url =
    settled.spec.exposure === "public"
      ? workerUrl(projectRef, cliConfig.projectHost, name)
      : undefined;

  // Suppressed when `-o` is in play: the payload owns stdout, and these lines
  // would land in the middle of it.
  if (output.format === "text" && !input.machineOutput) {
    yield* output.raw(
      renderWorkerDetails([
        ["runtime", runtime],
        ["size", formatApiSize(settled.spec.size)],
        ...(settled.imageVersion === undefined
          ? []
          : ([["image", settled.imageVersion]] as Array<readonly [string, string]>)),
        url === undefined ? ["access", "private (no HTTP endpoint)"] : ["url", url],
      ]),
    );
  }

  return {
    worker_name: name,
    runtime,
    size: settled.spec.size,
    exposure: settled.spec.exposure,
    instances: settled.spec.instances,
    image_version: settled.imageVersion,
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
  options: { readonly pollSchedule?: Schedule.Schedule<unknown> } = {},
) {
  const output = yield* Output;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const project = yield* legacyLoadWorkersProject();
  const projectRef = yield* resolver.resolve(flags.projectRef);

  // Go writes the linked-project cache and flushes telemetry in
  // `PersistentPostRun`, so both happen whether the command succeeds or fails.
  yield* Effect.gen(function* () {
    const requested =
      flags.names.length > 0
        ? yield* Effect.forEach(flags.names, legacyValidateWorkerName)
        : yield* legacyDiscoverWorkerNames(project);

    if (requested.length === 0) {
      return yield* Effect.fail(
        new NoWorkersToDeployError({
          detail: `No workers were named, and none were found in ${displayPath(
            project.projectRoot,
            project.rootDir,
          )}.`,
          suggestion: "Scaffold one with `supabase workers new <name>`.",
        }),
      );
    }

    const names = [...new Set(requested)];

    const machineOutput = yield* legacyWorkersMachineOutputRequested();
    const deployed: Array<Record<string, unknown>> = [];
    for (const name of names) {
      if (names.length > 1 && !machineOutput) {
        yield* output.raw(`\n${name}\n`);
      }
      deployed.push(
        yield* deployOneWorker({
          project,
          name,
          projectRef,
          instances: flags.instances,
          machineOutput,
          ...(options.pollSchedule === undefined ? {} : { pollSchedule: options.pollSchedule }),
        }),
      );
    }

    const payload = { project_ref: projectRef, workers: deployed };

    // `-o` asks for a machine-readable stdout, so nothing human may be written
    // to it — `output.success` logs to stdout in text mode.
    if (yield* legacyEmitWorkersGoOutput(payload)) {
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
