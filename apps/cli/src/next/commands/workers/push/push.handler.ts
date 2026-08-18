import { Effect, FileSystem, type Schedule } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { CliConfig } from "../../../config/cli-config.service.ts";
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
  UnknownWorkerRuntimeError,
  UnknownWorkerSizeError,
  WorkerBuildFailedError,
  WorkerSourceMissingError,
} from "../../../../shared/workers/workers.errors.ts";
import { resolveProjectRef } from "../../../config/resolve-project-ref.ts";
import { describeWorker, loadWorkersProject, resolveWorkerName } from "../workers.shared.ts";
import type { WorkersPushFlags } from "./push.command.ts";

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
  yield* output.warn(
    `No runtime configured for "${options.name}" — guessed ${classified.runtime} (${classified.reason}). ` +
      `Pin it down by adding [workers.${options.name}] runtime = "${classified.runtime}" to supabase/config.toml.`,
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

export const workersPush = Effect.fn("workers.push")(function* (
  flags: WorkersPushFlags,
  options: { readonly pollSchedule?: Schedule.Schedule<unknown> } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const api = yield* PlatformApi;
  const cliConfig = yield* CliConfig;

  yield* output.intro("Deploy worker");

  const project = yield* loadWorkersProject();
  const name = yield* resolveWorkerName({ project, name: flags.name, command: "push" });
  const worker = describeWorker(project, name);
  const projectRef = yield* resolveProjectRef(flags.projectRef);

  const runtime = yield* resolveRuntime({
    name,
    recorded: worker.entry?.runtime,
    sourceDir: worker.sourceDir,
  });

  // A bare sandbox has no code to package, so it is the one runtime that does
  // not need a source directory on disk at all.
  const needsContext = runtime !== "sandbox";
  const sourceDisplay = displayPath(project.cwd, worker.sourceDir);

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
    yield* output.info("Bare sandbox — no code is baked in.");
  }

  const spec: WorkerDeploySpec = {
    // A plain Dockerfile build has no catalog runtime to name; the uploaded
    // context carries its own Dockerfile and is built as-is.
    ...(runtime === "dockerfile" ? {} : { runtime }),
    size: apiSizeFor(size),
    exposure: exposureFor(runtime),
    instances: flags.instances,
  };

  const deploying = yield* output.task(`Deploying "${name}"...`);
  yield* deployWorker(api, projectRef, name, { spec, contextUploadId }).pipe(
    Effect.tapError(() => deploying.fail()),
  );

  const settled = yield* awaitWorkerBuild(api, projectRef, name, {
    schedule: options.pollSchedule,
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

  yield* output.success("Deployed worker.", {
    worker_name: name,
    project_ref: projectRef,
    runtime,
    size: settled.spec.size,
    exposure: settled.spec.exposure,
    instances: settled.spec.instances,
    image_version: settled.imageVersion,
    build_state: settled.buildState,
    ...(url === undefined ? {} : { url }),
  });

  if (output.format === "text") {
    yield* output.info(`runtime   ${runtime}`);
    yield* output.info(`size      ${formatApiSize(settled.spec.size)}`);
    if (settled.imageVersion !== undefined) {
      yield* output.info(`image     ${settled.imageVersion}`);
    }
    if (url === undefined) {
      yield* output.info("access    private (no HTTP endpoint)");
    } else {
      yield* output.info(`url       ${url}`);
    }
  }

  yield* output.outro(`Next: supabase workers status ${name}`);
});
