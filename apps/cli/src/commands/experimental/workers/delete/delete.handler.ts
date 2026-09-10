import { Effect, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { aqua } from "../../../../command-internal/colors.ts";
import { renderWorkerDetails } from "../workers.format.ts";
import {
  emitWorkersMachineOutput,
  rejectWorkersEnvOutput,
  workersMachineOutputRequested,
  workersProjectRefSuffix,
} from "../workers.output.ts";
import { CommandPlatformApi } from "../../../../auth/command-platform-api.service.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import { deleteWorker, getWorker } from "../../../../shared/workers/workers-api.ts";
import {
  WorkerDeleteConfirmationRequiredError,
  WorkerDeleteNotConfirmedError,
  WorkerNotDeployedError,
  WorkersApiUnexpectedStatusError,
} from "../../../../shared/workers/workers.errors.ts";
import { resolveYes } from "../../../../command-internal/global-flags.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  describeWorkerForReporting,
  loadWorkersProjectForReporting,
  validateWorkerName,
} from "../workers.shared.ts";
import type { WorkersDeleteFlags } from "./delete.command.ts";

/**
 * `supabase experimental workers delete [name]` — deletes the worker via the API
 * (never checking local files); an already-absent worker counts as success. The
 * worker's directory and `config.toml` entry stay on disk so `push <name>` can
 * redeploy it. Interactive runs require typing the name to confirm (`--yes`/
 * `SUPABASE_YES` skips it); without a terminal to prompt on, the command refuses.
 */
export const workersDelete = Effect.fn("experimental.workers.delete")(function* (
  flags: WorkersDeleteFlags,
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const tty = yield* Tty;
  const yes = yield* resolveYes;

  // Resolved here, outside the block below, since caching it is one of that
  // block's own finalizers — everything else that can fail belongs inside so
  // those failures still flush telemetry.
  const projectRef = yield* resolver.resolve(flags.projectRef);
  // Retry suggestions repeat a destructive command, so the ref must survive the copy-paste.
  const refSuffix = workersProjectRefSuffix(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* loadWorkersProjectForReporting();
    const name = yield* validateWorkerName(flags.name);
    const worker = yield* describeWorkerForReporting(project, name);

    // Checked before the DELETE call: checking at emit time would let `--yes -o env`
    // delete the worker, then exit non-zero with no payload for the caller to read.
    yield* rejectWorkersEnvOutput();

    const fetching = yield* output.task("Fetching worker...");
    // The GET is informational only: read (`edge_functions:read`) and delete
    // (`edge_functions:write`) are separate grants, so a 403 here must not block
    // a credential that is only entitled to delete.
    const lookup = yield* getWorker(api, projectRef, name).pipe(
      Effect.map((found) => ({ readable: true, worker: Option.getOrUndefined(found) })),
      Effect.catchIf(
        (error) => error instanceof WorkersApiUnexpectedStatusError && error.status === 403,
        () => Effect.succeed({ readable: false, worker: undefined }),
      ),
      Effect.tapError(() => fetching.fail()),
    );
    yield* fetching.clear();

    const deployed = lookup.worker;
    const machineOutput = yield* workersMachineOutputRequested();

    // `--yes` treats a DELETE 404 as success (a delete racing another delete still
    // happened), but this pre-flight check fails interactively so a re-run tells
    // the user nothing was there instead of silently succeeding.
    if (lookup.readable && deployed === undefined && !yes) {
      return yield* Effect.fail(
        new WorkerNotDeployedError({
          detail: `Nothing is deployed for "${name}" in project ${projectRef}.`,
          // Points at `list`, not `push` — the user wants to see what's deployed, not deploy it.
          suggestion: `See what is deployed with \`supabase experimental workers list${refSuffix}\`.`,
        }),
      );
    }

    if (!yes) {
      // Four checks, none alone sufficient: `-o json` leaves `output.format` as
      // `text`, so machine mode needs its own check; `output.interactive` only
      // tracks stdout, so piped stdin (e.g. `echo api | ... delete api`) also
      // needs `tty.stdinIsTty` — a confirmation typed from a pipe isn't real.
      if (output.format !== "text" || machineOutput || !output.interactive || !tty.stdinIsTty) {
        return yield* Effect.fail(
          new WorkerDeleteConfirmationRequiredError({
            detail: `Deleting "${name}" from project ${projectRef} needs confirmation, and there is no interactive terminal to ask on.`,
            suggestion: `Re-run \`supabase experimental workers delete ${name} --yes${refSuffix}\` to confirm without a prompt.`,
          }),
        );
      }

      // Uses the live instance count when known; otherwise falls back to the
      // declared target so a still-provisioning worker doesn't understate what
      // gets torn down. Both are absent when the read was refused.
      const live = deployed?.instances?.live;
      const declared = deployed?.spec.instances;
      const terminating =
        live !== undefined
          ? live > 0
            ? ` ${live} running instance${live === 1 ? "" : "s"} will be terminated.`
            : ""
          : declared !== undefined && declared > 0
            ? ` ${declared} declared instance${declared === 1 ? "" : "s"} will be terminated.`
            : "";
      yield* output.raw(
        `This permanently deletes "${name}" from project ${projectRef}.${terminating}\n`,
      );
      const typed = yield* output.promptText(`Type ${name} to confirm`);
      // Trimmed so a pasted trailing space doesn't force a re-run.
      if (typed.trim() !== name) {
        return yield* Effect.fail(
          new WorkerDeleteNotConfirmedError({
            detail: `The confirmation did not match "${name}", so nothing was deleted.`,
            suggestion: `Re-run \`supabase experimental workers delete ${name}${refSuffix}\` and type the name exactly, or pass --yes.`,
          }),
        );
      }
    }

    // Skipped only when the GET confirmed nothing exists; an unreadable worker
    // still gets the DELETE, since that's the request the credential may hold.
    if (deployed !== undefined || !lookup.readable) {
      const deleting = yield* output.task("Deleting worker...");
      yield* deleteWorker(api, projectRef, name).pipe(Effect.tapError(() => deleting.fail()));
      yield* deleting.clear();
    }

    // A worker deployed from another checkout has neither a local entry nor a
    // local directory, so there is nothing here that was kept.
    const keptSource = worker.sourceExists
      ? displayPath(project.projectRoot, worker.sourceDir)
      : undefined;
    const keptEntry = worker.entry !== undefined;

    const payload = {
      worker_name: name,
      project_ref: projectRef,
      ...(keptSource === undefined ? {} : { kept_source: keptSource }),
      kept_config_entry: keptEntry,
    };

    // `-o` asks for a machine-readable stdout, so nothing human may be written
    // to it — `output.success` logs to stdout in text mode.
    if (yield* emitWorkersMachineOutput(payload)) {
      return;
    }

    if (output.format !== "text") {
      yield* output.success("", payload);
      return;
    }

    {
      if (deployed === undefined && lookup.readable) {
        yield* output.raw(
          `Nothing was deployed for ${aqua(name, process.stdout)} in project ${projectRef}, so there was nothing to delete.\n`,
        );
        return;
      }

      yield* output.raw(
        `Deleted Worker ${aqua(name, process.stdout)} from project ${projectRef}\n`,
      );

      // Says "Kept" only when something remains; an orphaned worker has no
      // source or entry left, and pointing at `push` there would be a dead end.
      const kept = [
        ...(keptSource === undefined ? [] : [keptSource]),
        ...(keptEntry ? ["its supabase/config.toml entry"] : []),
      ];
      if (kept.length > 0) {
        yield* output.raw(renderWorkerDetails([["Kept", kept.join(", ")]]));
        // Only when the source remains: a config.toml entry alone can't redeploy,
        // so `push` would fail on the very command this recommends.
        if (keptSource !== undefined) {
          yield* emitSuccessTrailer(
            `Redeploy it with ${aqua(`supabase experimental workers push ${name}${refSuffix}`)}.\n`,
          );
        }
      } else {
        yield* output.raw(
          `Nothing for "${name}" exists in this project on disk, so nothing was kept.\n`,
          "stderr",
        );
      }
    }
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
