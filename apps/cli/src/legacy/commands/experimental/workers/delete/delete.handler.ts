import { Effect, Option } from "effect";
import { Output } from "../../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../../shared/cli/success-trailer.ts";
import { legacyAqua } from "../../../../shared/legacy-colors.ts";
import { legacyRenderWorkerDetails } from "../workers.format.ts";
import {
  legacyEmitWorkersMachineOutput,
  legacyRejectWorkersEnvOutput,
  legacyWorkersMachineOutputRequested,
} from "../workers.output.ts";
import { LegacyPlatformApi } from "../../../../auth/legacy-platform-api.service.ts";
import { displayPath } from "../../../../../shared/workers/worker-paths.ts";
import { deleteWorker, getWorker } from "../../../../../shared/workers/workers-api.ts";
import {
  WorkerDeleteConfirmationRequiredError,
  WorkerDeleteNotConfirmedError,
  WorkerNotDeployedError,
  WorkersApiUnexpectedStatusError,
} from "../../../../../shared/workers/workers.errors.ts";
import { legacyResolveYes } from "../../../../../shared/legacy/global-flags.ts";
import { Tty } from "../../../../../shared/runtime/tty.service.ts";
import {
  legacyDescribeWorkerForReporting,
  legacyLoadWorkersProjectForReporting,
  legacyValidateWorkerName,
} from "../workers.shared.ts";
import { legacyWorkersRun } from "../workers.run.ts";
import type { LegacyWorkersDeleteFlags } from "./delete.command.ts";

/**
 * `supabase experimental workers delete [name]` — delete the worker; its instances and image
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
 * local flag that would shadow the root one. It also makes an already-absent
 * worker a success: teardown run twice should not fail the second time.
 *
 * Without a terminal to prompt on there is no third option: `interactive` tracks
 * stdout, so merely redirecting output would otherwise delete unattended. This
 * refuses instead, and says which flag would have authorised it.
 */
export const legacyWorkersDelete = Effect.fn("legacy.experimental.workers.delete")(function* (
  flags: LegacyWorkersDeleteFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const tty = yield* Tty;
  // `--yes` OR `SUPABASE_YES`, matching `projects delete` and every other
  // command that guards a destructive step behind a prompt.
  const yes = yield* legacyResolveYes;

  yield* legacyWorkersRun(flags.projectRef, ({ projectRef, refSuffix }) =>
    Effect.gen(function* () {
      const project = yield* legacyLoadWorkersProjectForReporting();
      const name = yield* legacyValidateWorkerName(flags.name);
      const worker = yield* legacyDescribeWorkerForReporting(project, name);

      // Before the first API call, not at emit time: the emit branch is reached
      // *after* the DELETE, so `--yes -o env` deleted the worker and only then
      // exited non-zero with no payload — which a script reads as a failed delete.
      yield* legacyRejectWorkersEnvOutput();

      const fetching = yield* output.task("Fetching worker...");
      // The lookup is a courtesy, not a prerequisite: it supplies the instance
      // tally the confirmation quotes and the "already gone" verdict. The API
      // grants the read and the delete separately — `edge_functions:read` for
      // `GET`, `edge_functions:write` for `DELETE` — so a credential holding only
      // the latter could not delete a worker it is entitled to delete. A refused
      // read now leaves the worker *unknown* and the delete goes ahead.
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
      const machineOutput = yield* legacyWorkersMachineOutputRequested();

      // `--yes` is the scripted path, and `deleteWorker` already treats a DELETE
      // 404 as done — "a delete that races another one is still a delete that
      // happened". The pre-flight GET contradicted that for teardown: a script run
      // twice exited non-zero the second time, for a worker in exactly the state
      // it asked for. Interactively the error stays: somebody typed this command
      // and wants to hear the worker was not there.
      if (lookup.readable && deployed === undefined && !yes) {
        return yield* Effect.fail(
          new WorkerNotDeployedError({
            detail: `Nothing is deployed for "${name}" in project ${projectRef}.`,
            // `status`'s wording, inherited, pointed the wrong way here: somebody
            // deleting "api" and hearing "nothing is deployed" does not want to
            // deploy it — they want to see what *is* deployed.
            suggestion: `See what is deployed with \`supabase experimental workers list${refSuffix}\`.`,
          }),
        );
      }

      if (!yes) {
        // `-o json` leaves `output.format` as `text`, so the format check alone
        // still let the warning and the prompt run — onto the stdout the user had
        // asked to carry a payload. A machine format is as non-interactive as a
        // redirected stdout, whichever flag asked for it.
        //
        // `output.interactive` only tracks *stdout*, so on its own it still let
        // `printf 'api\n' | supabase experimental workers delete api` feed the pipe straight
        // into the prompt and delete without `--yes`. The confirmation is only
        // meaningful from a keyboard, so stdin has to be a terminal too — the same
        // pair `projects delete` guards its prompt with.
        if (output.format !== "text" || machineOutput || !output.interactive || !tty.stdinIsTty) {
          return yield* Effect.fail(
            new WorkerDeleteConfirmationRequiredError({
              detail: `Deleting "${name}" from project ${projectRef} needs confirmation, and there is no interactive terminal to ask on.`,
              suggestion: `Re-run \`supabase experimental workers delete ${name} --yes${refSuffix}\` to confirm without a prompt.`,
            }),
          );
        }

        // The live tally when the API reports one, labelled "declared" when it
        // does not. `spec.instances` is the target, which for a worker still
        // provisioning differs from what is running — and a destructive prompt is
        // the wrong place to overstate.
        // Absent when the read was refused: the prompt still asks for the name,
        // it just cannot quote a count it was not allowed to see.
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
        // Trimmed: a trailing space from a paste is not a different answer, and
        // making someone re-run a destructive command over one is just friction.
        if (typed.trim() !== name) {
          return yield* Effect.fail(
            new WorkerDeleteNotConfirmedError({
              detail: `The confirmation did not match "${name}", so nothing was deleted.`,
              suggestion: `Re-run \`supabase experimental workers delete ${name}${refSuffix}\` and type the name exactly, or pass --yes.`,
            }),
          );
        }
      }

      // Skipped only when the fetch actually said there is nothing there. An
      // unreadable worker still gets the DELETE — that request is the one the
      // credential is entitled to make, and the API treats a 404 on it as done.
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
      if (yield* legacyEmitWorkersMachineOutput(payload)) {
        return;
      }

      if (output.format !== "text") {
        yield* output.success("", payload);
        return;
      }

      {
        if (deployed === undefined && lookup.readable) {
          yield* output.raw(
            `Nothing was deployed for ${legacyAqua(name, process.stdout)} in project ${projectRef}, so there was nothing to delete.\n`,
          );
          return;
        }

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
            // Trailer, like every other "what to run next" line in this shell.
            yield* emitSuccessTrailer(
              `Redeploy it with ${legacyAqua(`supabase experimental workers push ${name}${refSuffix}`)}.\n`,
            );
          }
        } else {
          yield* output.raw(
            `Nothing for "${name}" exists in this project on disk, so nothing was kept.\n`,
            "stderr",
          );
        }
      }
    }),
  );
});
