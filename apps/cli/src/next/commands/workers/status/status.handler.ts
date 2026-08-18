import { Effect, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import { formatApiSize } from "../../../../shared/workers/worker-runtimes.ts";
import { workerUrl } from "../../../../shared/workers/worker-url.ts";
import { getWorker } from "../../../../shared/workers/workers-api.ts";
import { WorkerNotDeployedError } from "../../../../shared/workers/workers.errors.ts";
import { resolveProjectRef } from "../../../config/resolve-project-ref.ts";
import { describeWorker, loadWorkersProject, resolveWorkerName } from "../workers.shared.ts";
import type { WorkersStatusFlags } from "./status.command.ts";

/**
 * `supabase workers status [name]` — everything known about one worker.
 *
 * `list`'s companion: the size, image and URL a `push` printed once and then
 * scrolled away, plus the live instance tally, which is the only place it is
 * available — the list endpoint stays free of per-worker backend calls.
 */
export const workersStatus = Effect.fn("workers.status")(function* (flags: WorkersStatusFlags) {
  const output = yield* Output;
  const api = yield* PlatformApi;
  const cliConfig = yield* CliConfig;

  const project = yield* loadWorkersProject();
  const name = yield* resolveWorkerName({ project, name: flags.name, command: "status" });
  const worker = describeWorker(project, name);
  const projectRef = yield* resolveProjectRef(flags.projectRef);

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
  const sourceDisplay = displayPath(project.cwd, worker.sourceDir);

  yield* output.success("Read worker.", {
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
  });

  if (output.format !== "text") {
    return;
  }

  yield* output.info(`state     ${record.deleting === true ? "deleting" : record.buildState}`);
  if (record.stateReason !== undefined) {
    yield* output.info(`reason    ${record.stateReason}`);
  }
  // The deployed spec is the truth here, not `config.toml`: a worker deployed
  // from its own Dockerfile carries no `spec.runtime`, and letting a stale local
  // entry answer instead would report a runtime that is not what is running.
  yield* output.info(`runtime   ${record.spec.runtime ?? "dockerfile"}`);
  yield* output.info(`size      ${formatApiSize(record.spec.size)}`);
  yield* output.info(`access    ${record.spec.exposure}`);
  yield* output.info(`project   ${projectRef}`);
  if (record.imageVersion !== undefined) {
    yield* output.info(`image     ${record.imageVersion}`);
  }

  if (record.instances !== undefined) {
    yield* output.info(
      `instances ${record.instances.ready}/${record.spec.instances} ready · ${record.instances.live} live · ${record.instances.stale} stale`,
    );
  } else if (record.instancesError !== undefined) {
    yield* output.warn(`Instance counts could not be read: ${record.instancesError}`);
  } else {
    yield* output.info(`instances ${record.spec.instances} declared`);
  }

  if (url !== undefined) {
    yield* output.info(`url       ${url}`);
  }
  yield* output.info(`source    ${sourceDisplay}`);

  if (record.buildState === "failed") {
    yield* output.outro(`Try again: supabase workers push ${name}`);
  }
});
