import { Effect, Option } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { NotebookNotFoundError } from "../notebooks.errors.ts";
import {
  emitNotebooksMachineOutput,
  notebooksMachineOutputRequested,
  rejectNotebooksEnvOutput,
} from "../notebooks.output.ts";
import {
  deleteRemoteNotebook,
  downloadNotebook,
  ensureNotebookDestinationsUnique,
  ensureRemoteNotebookNamesUnique,
  listLocalNotebooks,
  listRemoteNotebooks,
  notebooksDir,
  promptNotebooksReconcile,
  readNotebookFile,
  uploadNotebook,
  writeNotebookFile,
  type NotebooksReconcileChoice,
} from "../notebooks.shared.ts";
import type { NotebooksPushFlags } from "./push.command.ts";

/**
 * `supabase notebooks push [name]` — write `supabase/notebooks/` into the
 * project.
 *
 * The mirror of `pull`: the checkout is the source, and every file is written to
 * the notebook of that name, or to a new one when the project has none. What is
 * left over — a project notebook naming no local file — is the divergence this
 * command asks about, for the same reason `pull` asks about its own.
 *
 * Every file is read and decoded before the first write, so a directory holding
 * one unreadable notebook fails without having half-pushed the rest.
 */
export const notebooksPush = Effect.fn("notebooks.push")(function* (flags: NotebooksPushFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const workdir = cliSettings.workdir;

  // The telemetry state file is written on every invocation, success or
  // failure, so everything that can fail lives inside the flush.
  yield* Effect.gen(function* () {
    // Refused before the project is resolved: failing at emit time would mean
    // failing after the project has already changed.
    yield* rejectNotebooksEnvOutput();
    const machineOutput = yield* notebooksMachineOutputRequested();

    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const local = yield* listLocalNotebooks(workdir);
      const requested = Option.getOrUndefined(flags.notebookName);

      if (requested !== undefined && !local.includes(requested)) {
        return yield* new NotebookNotFoundError({
          detail: `${notebooksDir(workdir)} has no notebook named "${requested}".`,
          suggestion:
            "Run supabase notebooks pull <notebook-id> to write the project's copy first.",
        });
      }

      const selected = requested === undefined ? local : [requested];

      // Read before anything is sent: one unreadable file stops the whole push
      // rather than leaving the project half-written.
      const files = yield* Effect.forEach(selected, (name) =>
        readNotebookFile(workdir, name).pipe(Effect.map((file) => ({ name, file }))),
      );

      const remote = yield* listRemoteNotebooks(api, ref);
      yield* ensureRemoteNotebookNamesUnique(
        requested === undefined ? remote : remote.filter((notebook) => notebook.name === requested),
      );

      // Only a whole-directory push reconciles: with a name given, the project's
      // other notebooks are not this invocation's business.
      const remoteOnly =
        requested === undefined ? remote.filter((notebook) => !local.includes(notebook.name)) : [];

      let choice: NotebooksReconcileChoice = "keep";
      if (remoteOnly.length > 0) {
        choice = yield* promptNotebooksReconcile({
          summary: `${remoteOnly.length} project notebook(s) are not in ${notebooksDir(workdir)}:`,
          names: remoteOnly.map((notebook) => notebook.name),
          copyLabel: `Write them into ${notebooksDir(workdir)}`,
          deleteLabel: "Delete them from the project",
          machineOutput,
        });
      }
      // Resolve and validate the selected plan before the first upload.
      if (choice === "copy") {
        yield* ensureNotebookDestinationsUnique(
          workdir,
          remoteOnly.map((notebook) => notebook.name),
        );
      }
      const downloads =
        choice === "copy"
          ? yield* Effect.forEach(remoteOnly, (notebook) =>
              downloadNotebook(api, ref, notebook).pipe(Effect.map((file) => ({ notebook, file }))),
            )
          : [];

      const created: Array<string> = [];
      const updated: Array<string> = [];
      const remoteByName = new Map(remote.map((notebook) => [notebook.name, notebook]));
      for (const { name, file } of files) {
        const result = yield* uploadNotebook({
          api,
          ref,
          name,
          file,
          existing: remoteByName.get(name),
        });
        (result === "created" ? created : updated).push(name);
      }

      let deleted: Array<string> = [];
      const pulled: Array<string> = [];
      if (choice === "delete") {
        for (const notebook of remoteOnly) {
          yield* deleteRemoteNotebook(api, ref, notebook);
        }
        deleted = remoteOnly.map((notebook) => notebook.name);
      }
      for (const { notebook, file } of downloads) {
        yield* writeNotebookFile(workdir, notebook.name, file);
        pulled.push(notebook.name);
      }

      const payload = {
        project_ref: ref,
        notebooks_dir: notebooksDir(workdir),
        created,
        updated,
        deleted,
        pulled,
      };

      if (yield* emitNotebooksMachineOutput(payload)) {
        return;
      }
      if (output.format !== "text") {
        yield* output.success("", payload);
        return;
      }

      yield* output.raw(
        files.length === 0
          ? `No notebooks in ${notebooksDir(workdir)} to push.\n`
          : `Pushed ${files.length} notebook(s) to ${ref} (${created.length} created, ${updated.length} updated)\n`,
      );
      if (deleted.length > 0) {
        yield* output.raw(`Deleted ${deleted.length} notebook(s) from the project.\n`);
      }
      if (pulled.length > 0) {
        yield* output.raw(`Wrote ${pulled.length} notebook(s) into the notebooks directory.\n`);
      }
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
