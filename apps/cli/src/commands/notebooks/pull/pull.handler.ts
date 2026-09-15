import { Effect, Option } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  emitNotebooksMachineOutput,
  notebooksMachineOutputRequested,
  rejectNotebooksEnvOutput,
} from "../notebooks.output.ts";
import {
  isNotebookNameWritable,
  downloadNotebook,
  downloadNotebookById,
  ensureNotebookDestinationsUnique,
  ensureRemoteNotebookNamesUnique,
  listLocalNotebooks,
  listRemoteNotebooks,
  notebooksDir,
  promptNotebooksReconcile,
  readNotebookFile,
  removeNotebookFile,
  uploadNotebook,
  validateNotebookId,
  writeNotebookFile,
} from "../notebooks.shared.ts";
import type { NotebooksPullFlags } from "./pull.command.ts";

/**
 * `supabase notebooks pull [id]` — write the project's notebooks into
 * `supabase/notebooks/`.
 *
 * The checkout is the source: a whole-directory pull only writes notebooks that
 * are not present locally. An explicit notebook id is the opt-in overwrite path.
 * What is left over — a local file naming no project notebook — is the divergence
 * this command asks about, because the file is either one somebody deleted in the
 * dashboard or one somebody added locally and never pushed.
 *
 * Given an id, only that notebook is pulled and nothing is reconciled: the
 * argument says which notebook to replace, so the rest of the directory is not
 * this invocation's business.
 */
export const notebooksPull = Effect.fn("notebooks.pull")(function* (flags: NotebooksPullFlags) {
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
    // Refused before the project is resolved: `-o env` cannot hold the payload,
    // and failing at emit time would mean failing after the files are written.
    yield* rejectNotebooksEnvOutput();
    const machineOutput = yield* notebooksMachineOutputRequested();

    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const pulled: Array<string> = [];
      const preserved: Array<string> = [];
      let skipped = 0;
      let localOnly: Array<string> = [];
      const requestedId = Option.getOrUndefined(flags.notebookId);

      if (requestedId !== undefined) {
        const id = yield* validateNotebookId(requestedId);
        const { notebook, file } = yield* downloadNotebookById(api, ref, id);
        yield* ensureNotebookDestinationsUnique(workdir, [notebook.name]);
        yield* writeNotebookFile(workdir, notebook.name, file, "replace");
        pulled.push(notebook.name);
      } else {
        const remote = yield* listRemoteNotebooks(api, ref);
        yield* ensureRemoteNotebookNamesUnique(remote);
        const local = yield* listLocalNotebooks(workdir);
        const localNames = new Set(local);

        // Names that cannot be file names are reported rather than sanitised: a
        // sanitised name would push back as a rename of somebody's notebook.
        const writable = remote.filter((notebook) => isNotebookNameWritable(notebook.name));
        skipped = remote.length - writable.length;
        yield* ensureNotebookDestinationsUnique(
          workdir,
          writable.map((notebook) => notebook.name),
        );

        for (const notebook of writable) {
          if (localNames.has(notebook.name)) {
            preserved.push(notebook.name);
            continue;
          }
          const file = yield* downloadNotebook(api, ref, notebook);
          yield* writeNotebookFile(workdir, notebook.name, file);
          pulled.push(notebook.name);
        }

        localOnly = local.filter((name) => !remote.some((notebook) => notebook.name === name));
      }

      let deleted: Array<string> = [];
      let pushed: Array<string> = [];
      if (localOnly.length > 0) {
        const choice = yield* promptNotebooksReconcile({
          summary: `${localOnly.length} local notebook(s) are not in the project:`,
          names: localOnly,
          copyLabel: "Create them in the project",
          deleteLabel: `Delete them from ${notebooksDir(workdir)}`,
          machineOutput,
        });

        if (choice === "delete") {
          for (const name of localOnly) {
            yield* removeNotebookFile(workdir, name);
          }
          deleted = [...localOnly];
        }
        if (choice === "copy") {
          const files = yield* Effect.forEach(localOnly, (name) =>
            readNotebookFile(workdir, name).pipe(Effect.map((file) => ({ name, file }))),
          );
          for (const { name, file } of files) {
            yield* uploadNotebook({ api, ref, name, file, existing: undefined });
          }
          pushed = [...localOnly];
        }
      }

      const payload = {
        project_ref: ref,
        notebooks_dir: notebooksDir(workdir),
        pulled,
        preserved_locally: preserved,
        created: pushed,
        deleted_locally: deleted,
        skipped,
      };

      if (yield* emitNotebooksMachineOutput(payload)) {
        return;
      }
      if (output.format !== "text") {
        yield* output.success("", payload);
        return;
      }

      yield* output.raw(
        pulled.length === 0
          ? "No notebooks to pull.\n"
          : `Pulled ${pulled.length} notebook(s) into ${notebooksDir(workdir)}\n`,
      );
      if (skipped > 0) {
        yield* output.raw(
          `Skipped ${skipped} notebook(s) whose name cannot be a file name.\n`,
          "stderr",
        );
      }
      if (preserved.length > 0) {
        yield* output.raw(`Kept ${preserved.length} existing local notebook(s) unchanged.\n`);
      }
      if (deleted.length > 0) {
        yield* output.raw(`Deleted ${deleted.length} local notebook(s).\n`);
      }
      if (pushed.length > 0) {
        yield* output.raw(`Created ${pushed.length} notebook(s) in the project.\n`);
      }
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
