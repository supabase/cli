import { Effect, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import { deleteWorker, getWorker } from "../../../../shared/workers/workers-api.ts";
import {
  WorkerDeleteNotConfirmedError,
  WorkerNotDeployedError,
} from "../../../../shared/workers/workers.errors.ts";
import { resolveProjectRef } from "../../../config/resolve-project-ref.ts";
import { describeWorker, loadWorkersProject, resolveWorkerName } from "../workers.shared.ts";
import type { WorkersDeleteFlags } from "./delete.command.ts";

/**
 * `supabase workers delete [name]` — delete the worker; its instances and image
 * are torn down asynchronously. Whether it exists is asked of the API, never of
 * a local file.
 *
 * Note what it does *not* remove: the worker's directory and its `config.toml`
 * entry stay on disk, so `push <name>` brings it straight back — which is why
 * the command says so.
 *
 * Being irreversible, an interactive session has to type the worker's name back
 * to proceed — the same "confirm by typing it" pattern as GitHub's own repo
 * deletion, rather than a bare y/n that is too easy to reflexively confirm.
 * `--yes` skips it for scripts, as does a non-interactive session, where there
 * would be nothing to read.
 */
export const workersDelete = Effect.fn("workers.delete")(function* (flags: WorkersDeleteFlags) {
  const output = yield* Output;
  const api = yield* PlatformApi;

  const project = yield* loadWorkersProject();
  const name = yield* resolveWorkerName({ project, name: flags.name, command: "delete" });
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

  if (!flags.yes && output.format === "text" && output.interactive) {
    const instances = found.value.spec.instances;
    yield* output.warn(
      `This permanently deletes "${name}" from project ${projectRef}.` +
        (instances > 0
          ? ` ${instances} running instance${instances === 1 ? "" : "s"} will be terminated.`
          : ""),
    );
    const typed = yield* output.promptText(`Type ${name} to confirm`);
    // Trimmed: a trailing space from a paste is not a different answer, and
    // making someone re-run a destructive command over one is just friction.
    if (typed.trim() !== name) {
      return yield* Effect.fail(
        new WorkerDeleteNotConfirmedError({
          detail: `The confirmation did not match "${name}", so nothing was deleted.`,
          suggestion: `Re-run \`supabase workers delete ${name}\` and type the name exactly, or pass --yes.`,
        }),
      );
    }
  }

  const deleting = yield* output.task(`Deleting "${name}"...`);
  yield* deleteWorker(api, projectRef, name).pipe(Effect.tapError(() => deleting.fail()));
  yield* deleting.succeed(`Deleted "${name}".`);

  const sourceDisplay = displayPath(project.cwd, worker.sourceDir);

  yield* output.success("Deleted worker.", {
    worker_name: name,
    project_ref: projectRef,
    kept_source: sourceDisplay,
  });

  if (output.format === "text") {
    // "Deleted" reads more final than it is: the source and its config entry are
    // still here, and redeploying is one command away.
    yield* output.info(`kept      ${sourceDisplay} · its supabase/config.toml entry`);
    yield* output.outro(`Redeploy any time: supabase workers push ${name}`);
  }
});
