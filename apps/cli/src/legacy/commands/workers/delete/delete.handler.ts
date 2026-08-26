import { Effect, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
import { legacyRenderWorkerDetails } from "../workers.format.ts";
import {
  legacyEmitWorkersMachineOutput,
  legacyRejectWorkersEnvOutput,
  legacyWorkersMachineOutputRequested,
} from "../workers.output.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import { deleteWorker, getWorker } from "../../../../shared/workers/workers-api.ts";
import {
  WorkerDeleteConfirmationRequiredError,
  WorkerDeleteNotConfirmedError,
  WorkerNotDeployedError,
} from "../../../../shared/workers/workers.errors.ts";
import { legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyDescribeWorkerForReporting,
  legacyLoadWorkersProject,
  legacyValidateWorkerName,
} from "../workers.shared.ts";
import type { LegacyWorkersDeleteFlags } from "./delete.command.ts";

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
 * `--yes`/`SUPABASE_YES` skips it for scripts, resolved through
 * `legacyResolveYes` like every other confirming command rather than through a
 * local flag that would shadow the root one.
 *
 * Without a terminal to prompt on there is no third option: `interactive` tracks
 * stdout, so merely redirecting output would otherwise delete unattended. This
 * refuses instead, and says which flag would have authorised it.
 */
export const legacyWorkersDelete = Effect.fn("legacy.workers.delete")(function* (
  flags: LegacyWorkersDeleteFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  // `--yes` OR `SUPABASE_YES`, matching `projects delete` and every other
  // command that guards a destructive step behind a prompt.
  const yes = yield* legacyResolveYes;

  // The ref is resolved outside the finalizers because caching it is one of
  // them; everything that can fail on its own — loading `config.toml`,
  // validating the name, resolving the worker — belongs inside, so those
  // failures still flush telemetry. Same shape as `config/push`.
  const projectRef = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* legacyLoadWorkersProject();
    const name = yield* legacyValidateWorkerName(flags.name);
    const worker = yield* legacyDescribeWorkerForReporting(project, name);

    // Before the first API call, not at emit time: the emit branch is reached
    // *after* the DELETE, so `--yes -o env` deleted the worker and only then
    // exited non-zero with no payload — which a script reads as a failed delete.
    yield* legacyRejectWorkersEnvOutput();

    const fetching = yield* output.task("Fetching worker...");
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

    const machineOutput = yield* legacyWorkersMachineOutputRequested();

    if (!yes) {
      // `-o json` leaves `output.format` as `text`, so the format check alone
      // still let the warning and the prompt run — onto the stdout the user had
      // asked to carry a payload. A machine format is as non-interactive as a
      // redirected stdout, whichever flag asked for it.
      if (output.format !== "text" || machineOutput || !output.interactive) {
        return yield* Effect.fail(
          new WorkerDeleteConfirmationRequiredError({
            detail: `Deleting "${name}" from project ${projectRef} needs confirmation, and there is no interactive terminal to ask on.`,
            suggestion: `Re-run \`supabase workers delete ${name} --yes\` to confirm without a prompt.`,
          }),
        );
      }

      // The live tally when the API reports one, labelled "declared" when it
      // does not. `spec.instances` is the target, which for a worker still
      // provisioning differs from what is running — and a destructive prompt is
      // the wrong place to overstate.
      const live = found.value.instances?.live;
      const declared = found.value.spec.instances;
      const terminating =
        live !== undefined
          ? live > 0
            ? ` ${live} running instance${live === 1 ? "" : "s"} will be terminated.`
            : ""
          : declared > 0
            ? ` ${declared} declared instance${declared === 1 ? "" : "s"} will be terminated.`
            : "";
      yield* output.raw(
        `This permanently deletes "${name}" from project ${projectRef}.${terminating}\n`,
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

    const deleting = yield* output.task("Deleting worker...");
    yield* deleteWorker(api, projectRef, name).pipe(Effect.tapError(() => deleting.fail()));
    yield* deleting.clear();

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
    if (yield* legacyEmitWorkersMachineOutput(payload)) {
      return;
    }

    if (output.format !== "text") {
      yield* output.success("", payload);
      return;
    }

    {
      yield* output.raw(
        `Deleted Worker ${legacyAqua(name, process.stdout)} from project ${projectRef}\n`,
      );

      // "Deleted" reads more final than it is *when there is something left* —
      // so only say so when there is. For an orphan there is nothing local to
      // keep, and pointing at `push` would send the user at a command that has
      // no source to deploy.
      const kept = [
        ...(keptSource === undefined ? [] : [keptSource]),
        ...(keptEntry ? ["its supabase/config.toml entry"] : []),
      ];
      if (kept.length > 0) {
        yield* output.raw(legacyRenderWorkerDetails([["Kept", kept.join(", ")]]));
        // Only when the source is still there: a retained `config.toml` entry
        // alone is not enough to redeploy from, so `push` would fail on the very
        // command this line recommends.
        if (keptSource !== undefined) {
          yield* output.raw(`Redeploy it with supabase workers push ${name}.\n`);
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
