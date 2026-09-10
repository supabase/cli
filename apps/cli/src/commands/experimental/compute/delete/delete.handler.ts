import { Effect, Option, Path } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { aqua } from "../../../../command-internal/colors.ts";
import { renderComputeDetails } from "../compute.format.ts";
import {
  emitComputeMachineOutput,
  rejectComputeEnvOutput,
  computeMachineOutputRequested,
  computeProjectRefSuffix,
} from "../compute.output.ts";
import { CommandPlatformApi } from "../../../../auth/command-platform-api.service.ts";
import { displayPath } from "../../../../shared/compute/compute-paths.ts";
import { deleteCompute, getCompute } from "../../../../shared/compute/compute-api.ts";
import {
  ComputeDeleteConfirmationRequiredError,
  ComputeDeleteNotConfirmedError,
  ComputeNotDeployedError,
  ComputeApiUnexpectedStatusError,
} from "../../../../shared/compute/compute.errors.ts";
import { resolveYes } from "../../../../command-internal/global-flags.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  describeComputeForReporting,
  loadComputeProjectForReporting,
  validateComputeName,
} from "../compute.shared.ts";
import type { ComputeDeleteFlags } from "./delete.command.ts";

/**
 * `supabase compute delete [name]` — deletes the compute via the API
 * (never checking local files); an already-absent compute counts as success. The
 * compute's directory and `config.toml` entry stay on disk so `push <name>` can
 * redeploy it. Interactive runs require typing the name to confirm (`--yes`/
 * `SUPABASE_YES` skips it); without a terminal to prompt on, the command refuses.
 */
export const computeDelete = Effect.fn("compute.delete")(function* (flags: ComputeDeleteFlags) {
  const output = yield* Output;
  const path = yield* Path.Path;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const tty = yield* Tty;
  const yes = yield* resolveYes;

  // The ref is resolved outside the finalizers because caching it is one of
  // them; everything that can fail on its own — loading `config.toml`,
  // validating the name, resolving the compute — belongs inside, so those
  // failures still flush telemetry. Same shape as `config/push`.
  const projectRef = yield* resolver.resolve(flags.projectRef);
  // Every retry this command suggests is for a *destructive* re-run, so the ref
  // has to survive the copy-paste.
  const refSuffix = computeProjectRefSuffix(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* loadComputeProjectForReporting();
    const name = yield* validateComputeName(flags.name);
    const compute = yield* describeComputeForReporting(project, name);

    // Before the first API call, not at emit time: the emit branch is reached
    // *after* the DELETE, so `--yes -o env` deleted the compute and only then
    // exited non-zero with no payload — which a script reads as a failed delete.
    yield* rejectComputeEnvOutput();

    const fetching = yield* output.task("Fetching compute...");
    // The lookup is a courtesy, not a prerequisite: it supplies the instance
    // tally the confirmation quotes and the "already gone" verdict. The API
    // grants the read and the delete separately — `edge_functions:read` for
    // `GET`, `edge_functions:write` for `DELETE` — so a credential holding only
    // the latter could not delete a compute it is entitled to delete. A refused
    // read now leaves the compute *unknown* and the delete goes ahead.
    const lookup = yield* getCompute(api, projectRef, name).pipe(
      Effect.map((found) => ({ readable: true, compute: Option.getOrUndefined(found) })),
      Effect.catchIf(
        (error) => error instanceof ComputeApiUnexpectedStatusError && error.status === 403,
        () => Effect.succeed({ readable: false, compute: undefined }),
      ),
      Effect.tapError(() => fetching.fail()),
    );
    yield* fetching.clear();

    const deployed = lookup.compute;
    const machineOutput = yield* computeMachineOutputRequested();

    // `--yes` is the scripted path, and `deleteCompute` already treats a DELETE
    // 404 as done — "a delete that races another one is still a delete that
    // happened". The pre-flight GET contradicted that for teardown: a script run
    // twice exited non-zero the second time, for a compute in exactly the state
    // it asked for. Interactively the error stays: somebody typed this command
    // and wants to hear the compute was not there.
    if (lookup.readable && deployed === undefined && !yes) {
      return yield* new ComputeNotDeployedError({
        detail: `Nothing is deployed for "${name}" in project ${projectRef}.`,
        // `status`'s wording, inherited, pointed the wrong way here: somebody
        // deleting "api" and hearing "nothing is deployed" does not want to
        // deploy it — they want to see what *is* deployed.
        suggestion: `See what is deployed with \`supabase compute list${refSuffix}\`.`,
      });
    }

    if (!yes) {
      // `-o json` leaves `output.format` as `text`, so the format check alone
      // still let the warning and the prompt run — onto the stdout the user had
      // asked to carry a payload. A machine format is as non-interactive as a
      // redirected stdout, whichever flag asked for it.
      //
      // `output.interactive` only tracks *stdout*, so on its own it still let
      // `printf 'api\n' | supabase compute delete api` feed the pipe straight
      // into the prompt and delete without `--yes`. The confirmation is only
      // meaningful from a keyboard, so stdin has to be a terminal too — the same
      // pair `projects delete` guards its prompt with.
      if (output.format !== "text" || machineOutput || !output.interactive || !tty.stdinIsTty) {
        return yield* new ComputeDeleteConfirmationRequiredError({
          detail: `Deleting "${name}" from project ${projectRef} needs confirmation, and there is no interactive terminal to ask on.`,
          suggestion: `Re-run \`supabase compute delete ${name} --yes${refSuffix}\` to confirm without a prompt.`,
        });
      }

      // Uses the live instance count when known; otherwise falls back to the
      // declared target so a still-provisioning compute doesn't understate what
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
        return yield* new ComputeDeleteNotConfirmedError({
          detail: `The confirmation did not match "${name}", so nothing was deleted.`,
          suggestion: `Re-run \`supabase compute delete ${name}${refSuffix}\` and type the name exactly, or pass --yes.`,
        });
      }
    }

    // Skipped only when the GET confirmed nothing exists; an unreadable compute
    // still gets the DELETE, since that's the request the credential may hold.
    if (deployed !== undefined || !lookup.readable) {
      const deleting = yield* output.task("Deleting compute...");
      yield* deleteCompute(api, projectRef, name).pipe(Effect.tapError(() => deleting.fail()));
      yield* deleting.clear();
    }

    // A compute deployed from another checkout has neither a local entry nor a
    // local directory, so there is nothing here that was kept.
    const keptSource = compute.sourceExists
      ? displayPath(path, project.projectRoot, compute.sourceDir)
      : undefined;
    const keptEntry = compute.entry !== undefined;

    const payload = {
      compute_name: name,
      project_ref: projectRef,
      ...(keptSource === undefined ? {} : { kept_source: keptSource }),
      kept_config_entry: keptEntry,
    };

    // `-o` asks for a machine-readable stdout, so nothing human may be written
    // to it — `output.success` logs to stdout in text mode.
    if (yield* emitComputeMachineOutput(payload)) {
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
        `Deleted Compute ${aqua(name, process.stdout)} from project ${projectRef}\n`,
      );

      // Says "Kept" only when something remains; an orphaned Compute service has no
      // source or entry left, and pointing at `push` there would be a dead end.
      const kept = [
        ...(keptSource === undefined ? [] : [keptSource]),
        ...(keptEntry ? ["its supabase/config.toml entry"] : []),
      ];
      if (kept.length > 0) {
        yield* output.raw(renderComputeDetails([["Kept", kept.join(", ")]]));
        // Only when the source is still there: a retained `config.toml` entry
        // alone is not enough to redeploy from, so `push` would fail on the very
        // command this line recommends.
        if (keptSource !== undefined) {
          yield* emitSuccessTrailer(
            `Redeploy it with ${aqua(`supabase compute push ${name}${refSuffix}`)}.\n`,
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
