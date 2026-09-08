import { join, relative, sep } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { aqua, bold } from "../../../../command-internal/colors.ts";
import { validateWorkdirIsDirectory } from "../../../../command-internal/workdir-validation.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { renderWorkerDetails } from "../workers.format.ts";
import { emitWorkersPayload, workersRendersText } from "../workers.output.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import {
  commitWorkerEntry,
  planWorkerEntry,
  WorkerAlreadyConfiguredError,
} from "../../../../shared/workers/worker-config.ts";
import {
  confineWorkerPath,
  displayPath,
  resolveWorkerSource,
} from "../../../../shared/workers/worker-paths.ts";
import {
  DEFAULT_WORKER_EXPOSURE,
  DEFAULT_WORKER_INSTANCES,
  DEFAULT_WORKER_RUNTIME,
  DEFAULT_WORKER_SIZE,
  parseWorkerExposure,
  parseWorkerRuntime,
  parseWorkerSize,
  validateWorkerNameMessage,
  vcpuForSize,
  WORKER_EXPOSURE_DESCRIPTIONS,
  WORKER_EXPOSURES,
  WORKER_RUNTIME_DESCRIPTIONS,
  WORKER_RUNTIMES,
  WORKER_SIZES,
  type WorkerExposure,
  type WorkerRuntime,
  type WorkerSize,
} from "../../../../shared/workers/worker-runtimes.ts";
import { WORKER_STACKS } from "../../../../shared/workers/worker-stacks.ts";
import {
  MissingWorkerNameError,
  WorkerDirectoryExistsError,
} from "../../../../shared/workers/workers.errors.ts";
import {
  loadWorkersProject,
  loadWorkersProjectForEntryWrite,
  validateWorkerName,
  type WorkersProject,
} from "../workers.shared.ts";
import type { WorkersNewFlags } from "./new.command.ts";
import { WorkersNewWorkdirError } from "./new.errors.ts";

/**
 * `supabase experimental workers new [name]` — scaffold `supabase/workers/<name>/` from the
 * chosen runtime's starter files and record the choice in `config.toml`.
 * Nothing is deployed; this is entirely local-disk work.
 *
 * The name, runtime, size and exposure are all resolved *before* anything is
 * written, so a cancelled prompt leaves nothing behind for this worker at all.
 * `--instances` is recorded rather than resolved: it has no prompt, and it only
 * reaches `config.toml` when it differs from the default.
 */

/** `values`, with `defaultValue` first, so a prompt pre-selects what it shows first. */
function defaultFirst<T>(values: ReadonlyArray<T>, defaultValue: T): Array<T> {
  return [defaultValue, ...values.filter((value) => value !== defaultValue)];
}

/**
 * Whether this run has a terminal to ask on.
 *
 * `-o json|yaml|toml|env` leaves `output.format` as `text`, and the prompts go
 * through Clack, which writes its terminal UI to stdout with no stream
 * override — so a machine format is as non-interactive as a redirected stdout,
 * whichever flag asked for it.
 *
 * `output.interactive` only tracks *stdout*, so on its own it still let
 * `printf 'api\n' | supabase experimental workers new` feed the pipe straight
 * into the name prompt instead of taking the documented non-interactive path. A
 * prompt is only answerable from a keyboard, so stdin has to be a terminal too
 * — the same pair `workers delete` guards its confirmation with.
 */
const canPromptForThisRun = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const tty = yield* Tty;
  return (yield* workersRendersText()) && output.interactive && tty.stdinIsTty;
});

/**
 * The worker name, asked for when the command line did not carry one.
 *
 * The name is the one input here that cannot be defaulted — it is the
 * directory, the `config.toml` key and the hostname — so a bare
 * `supabase experimental workers new` asks rather than failing the parse. The
 * prompt validates against everything the command would otherwise refuse a
 * moment later, so a mistyped or already-recorded name is corrected in place
 * instead of ending the run.
 */
const resolveName = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<string>;
  /** Whether there is a terminal to ask on — see `canPromptForThisRun`. */
  readonly canPrompt: boolean;
  readonly project: WorkersProject;
}) {
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  if (options.canPrompt) {
    const output = yield* Output;
    return yield* output.promptText("What should this worker be called?", {
      validate: (value) => {
        const invalid = validateWorkerNameMessage(value);
        if (invalid !== undefined) {
          return invalid;
        }
        return options.project.section.workers[value] === undefined
          ? undefined
          : `"${value}" is already configured in ${options.project.configPath}.`;
      },
    });
  }

  return yield* Effect.fail(
    new MissingWorkerNameError({
      detail: "Worker name is required in non-interactive mode.",
      suggestion: "Pass a worker name, for example `supabase experimental workers new api`.",
    }),
  );
});

const resolveRuntime = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<WorkerRuntime>;
  /** Whether there is a terminal to ask on — see `canPromptForThisRun`. */
  readonly canPrompt: boolean;
}) {
  // `--runtime` is a choice flag, so the parser has already rejected anything
  // outside the catalog by the time it gets here.
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  if (options.canPrompt) {
    const output = yield* Output;
    const selected = yield* output.promptSelect(
      "Which runtime should this worker use?",
      defaultFirst([...WORKER_RUNTIMES], DEFAULT_WORKER_RUNTIME).map((runtime) => ({
        value: runtime,
        label: runtime,
        hint: WORKER_RUNTIME_DESCRIPTIONS[runtime],
      })),
    );
    return parseWorkerRuntime(selected) ?? DEFAULT_WORKER_RUNTIME;
  }

  return DEFAULT_WORKER_RUNTIME;
});

const resolveSize = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<WorkerSize>;
  /** Whether there is a terminal to ask on — see `canPromptForThisRun`. */
  readonly canPrompt: boolean;
}) {
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  if (options.canPrompt) {
    const output = yield* Output;
    const selected = yield* output.promptSelect(
      "Which instance size should this worker use?",
      defaultFirst([...WORKER_SIZES], DEFAULT_WORKER_SIZE).map((size) => ({
        value: size,
        label: `${size} (${vcpuForSize(size)} vCPU)`,
      })),
    );
    return parseWorkerSize(selected) ?? DEFAULT_WORKER_SIZE;
  }

  return DEFAULT_WORKER_SIZE;
});

/**
 * Recorded on every scaffold, not just when it is asked for: `push` sends a
 * complete spec each time, so a worker whose `exposure` is absent from
 * `config.toml` is deployed public by the next bare `push`. Writing the value
 * down — default included, the way `runtime` and `size` are — is what makes
 * `--exposure private` stick past the deploy that chose it.
 */
const resolveExposure = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<WorkerExposure>;
  /** Whether there is a terminal to ask on — see `canPromptForThisRun`. */
  readonly canPrompt: boolean;
}) {
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  if (options.canPrompt) {
    const output = yield* Output;
    const selected = yield* output.promptSelect(
      "Should this worker be reachable from the internet?",
      defaultFirst([...WORKER_EXPOSURES], DEFAULT_WORKER_EXPOSURE).map((exposure) => ({
        value: exposure,
        label: exposure,
        hint: WORKER_EXPOSURE_DESCRIPTIONS[exposure],
      })),
    );
    return parseWorkerExposure(selected) ?? DEFAULT_WORKER_EXPOSURE;
  }

  return DEFAULT_WORKER_EXPOSURE;
});

/**
 * The instance count to record, and whether to record it at all.
 *
 * Not prompted for, unlike the other dials: how many instances a worker needs is
 * an operational answer nobody has while scaffolding it, so the flag records
 * one when it is given and the file stays quiet when it is not.
 *
 * `undefined` — meaning "write no key" — for the default count, because an
 * absent `instances` and `instances = 1` mean the same thing to `push`, and a
 * scaffold should not commit a line that says nothing. A `0` is not that: it
 * scales the worker to nothing, so it is written like any other explicit count.
 */
function recordedInstances(explicit: Option.Option<number>): number | undefined {
  const instances = Option.getOrUndefined(explicit);
  return instances === undefined || instances === DEFAULT_WORKER_INSTANCES ? undefined : instances;
}

/**
 * Whether the destination is free for a scaffold: nothing there, or an empty
 * directory. A plain file counts as occupied, so it is refused by name rather
 * than by a bare `EEXIST` from `makeDirectory`.
 */
const destinationIsFree = Effect.fnUntraced(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(target).pipe(Effect.option);
  if (Option.isNone(info)) {
    return true;
  }
  if (info.value.type !== "Directory") {
    return false;
  }
  const entries = yield* fs.readDirectory(target).pipe(Effect.orElseSucceed(() => []));
  return entries.length === 0;
});

export const workersNew = Effect.fn("experimental.workers.new")(function* (flags: WorkersNewFlags) {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const runtimeInfo = yield* RuntimeInfo;
  const cliSettings = yield* CommandSettings;

  // The telemetry state file is written on every invocation, success or failure.
  yield* Effect.gen(function* () {
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new WorkersNewWorkdirError({ message: error.message })),
    );

    const project = yield* loadWorkersProjectForEntryWrite();

    // Decided once, before the first prompt rather than beside the last, since
    // the name is now asked for too — every prompt below shares the answer.
    const canPrompt = yield* canPromptForThisRun();

    const name = yield* resolveName({ explicit: flags.name, canPrompt, project });
    yield* validateWorkerName(name);

    // Refused before anything is asked or written. `new` creates a worker;
    // changing one that already exists is a `config.toml` edit, and the file is
    // the user's. Checking here rather than only in `planWorkerEntry` means the
    // runtime and size prompts never run for a name that was going to be
    // refused anyway; the name prompt rejects it up front for the same reason.
    if (project.section.workers[name] !== undefined) {
      return yield* Effect.fail(
        new WorkerAlreadyConfiguredError({
          detail: `"${name}" is already configured in ${project.configPath}.`,
          suggestion: `Edit [workers.${name}] in ${project.configPath} yourself, or pick a different worker name.`,
        }),
      );
    }

    // A DEFAULTED workdir's reader (`workers list`/`push`/`status`, used
    // via `loadWorkersProject`) can discover a config.json-only
    // ancestor project by climbing (CLI-2285); this command's own writer
    // above is TOML-only and never climbs, so the two can disagree about
    // which project is "the" project. When they do, and that ancestor
    // already configures this name, writing a same-named worker here would
    // silently create a second, disagreeing `[workers.<name>]` under a
    // different root instead of the collision already refused above for
    // this command's OWN root. An explicit `--workdir`/`SUPABASE_WORKDIR`
    // never has this gap — both views are pinned to the same root then — so
    // this only runs for a defaulted workdir, and only costs an extra read
    // when it is.
    if (!cliSettings.explicitWorkdir) {
      const discovered = yield* loadWorkersProject().pipe(Effect.option);
      if (
        Option.isSome(discovered) &&
        discovered.value.projectRoot !== project.projectRoot &&
        discovered.value.section.workers[name] !== undefined
      ) {
        return yield* Effect.fail(
          new WorkerAlreadyConfiguredError({
            detail: `"${name}" is already configured in ${discovered.value.configPath}.`,
            suggestion: `Run this command from ${discovered.value.projectRoot} to manage it there, or pick a different worker name.`,
          }),
        );
      }
    }

    // Resolved before anything is written, so cancelling any prompt leaves
    // nothing behind — the name included. With nowhere to ask, the defaults
    // stand; only the name has nothing to fall back to.
    const runtime = yield* resolveRuntime({ explicit: flags.runtime, canPrompt });
    const size = yield* resolveSize({ explicit: flags.size, canPrompt });
    const exposure = yield* resolveExposure({ explicit: flags.exposure, canPrompt });
    const instances = recordedInstances(flags.instances);

    // Validated before anything is written: this is the directory the starter
    // files land in, so a value naming the project root, `supabase/`, or
    // anywhere outside the project must never get as far as the write below.
    //
    // `--source` resolves against the directory the user typed it in, the way a
    // shell would read it: `--source generated` from `apps/web` means
    // `apps/web/generated`.
    const destination = Option.isSome(flags.source)
      ? yield* resolveWorkerSource({
          projectRoot: project.projectRoot,
          cwd: runtimeInfo.cwd,
          raw: flags.source.value,
        })
      : yield* confineWorkerPath({
          projectRoot: project.projectRoot,
          target: join(project.workersDir, name),
          subject: `The default directory for "${name}"`,
          // The default directory is `supabase/workers/<name>` with a validated
          // name, so it cannot be the project root, `supabase/`, or a directory
          // the CLI owns. A symlink escaping the project is the only way it
          // reaches this failure, so that is what the suggestion names.
          suggestion:
            "supabase/workers, or a directory above it, is a symlink leading outside the project. Replace it with a real directory, or pass --source to scaffold somewhere else inside the project.",
        });

    // Nothing here replaces what is already on disk. Scaffolding over an
    // existing directory would have to delete it first, and a command whose job
    // is to create a worker has no business removing whatever happens to share
    // its name — so it says what is in the way and leaves the choice to the user.
    if (!(yield* destinationIsFree(destination))) {
      // Absolute when `--workdir`/`SUPABASE_WORKDIR` was set explicitly — same
      // rule as the success message below — since a project-root-relative
      // path would be misleading once `--workdir` differs from cwd.
      const shown = cliSettings.explicitWorkdir
        ? destination
        : displayPath(project.projectRoot, destination);
      return yield* Effect.fail(
        new WorkerDirectoryExistsError({
          detail: `${shown} already exists and is not empty.`,
          suggestion: `Remove ${shown} yourself if you meant to replace it, or pick a different worker name.`,
        }),
      );
    }

    // Recorded as forward slashes whatever platform wrote it. `config.toml` is
    // committed and shared, and `path.relative` yields `packages\api` on
    // Windows — a backslash the POSIX resolvers on every other machine read as
    // a literal character in a filename rather than a separator.
    const source = Option.isSome(flags.source)
      ? relative(project.projectRoot, destination).split(sep).join("/")
      : undefined;

    // Planned before anything is written. Every way this can fail is knowable
    // from the current config.toml, so finding out afterwards would leave a
    // scaffold on disk that nothing records.
    const configWrite = yield* planWorkerEntry({
      configPath: project.configPath,
      name,
      existingWorkers: project.section.workers,
      patch: {
        runtime,
        size,
        exposure,
        ...(instances === undefined ? {} : { instances }),
        ...(source === undefined ? {} : { source }),
      },
    });

    // Everything below this line changes the user's disk, and nothing below it
    // can fail for a reason the plan above could have caught.
    yield* fs.makeDirectory(destination, { recursive: true });

    for (const [filename, contents] of Object.entries(WORKER_STACKS[runtime])) {
      yield* fs.writeFileString(join(destination, filename), contents);
    }

    yield* commitWorkerEntry(configWrite);

    // Relative to the project root when the workdir was defaulted — the
    // common case, where it also reads as relative to the terminal the
    // command was run from. An explicit `--workdir` breaks that: the project
    // root can be nowhere near the actual cwd, so a relative path here would
    // point somewhere the user never typed. The absolute path is unambiguous
    // either way.
    const sourceDisplay = cliSettings.explicitWorkdir
      ? destination
      : displayPath(project.projectRoot, destination);

    const payload = {
      worker_name: name,
      runtime,
      size,
      vcpu: vcpuForSize(size),
      exposure,
      // The count a deploy will use, whether or not it was written down — a
      // payload that omitted it for the default would read as "unknown" rather
      // than "one".
      instances: instances ?? DEFAULT_WORKER_INSTANCES,
      source: sourceDisplay,
      config_path: project.configPath,
    };

    if (yield* emitWorkersPayload(payload)) {
      return;
    }

    // Leads with a declarative line the way every other scaffold does
    // (`functions new`: "Created new Function at supabase/functions/hello"),
    // then the details. Guidance goes in a closing sentence rather than a
    // pseudo-row, since no other command puts a next step inside its output
    // table.
    yield* output.raw(`Created new Worker at ${bold(sourceDisplay, process.stdout)}\n`);
    yield* output.raw(
      renderWorkerDetails([
        ["Runtime", runtime],
        ["Size", `${size} (${vcpuForSize(size)} vCPU)`],
        ["Access", exposure],
        // `declared`, the way `workers status` labels the same number: nothing
        // is running yet, so a bare count would read as a live tally.
        ["Instances", `${instances ?? DEFAULT_WORKER_INSTANCES} declared`],
      ]),
    );
    // On the success trailer rather than inline, the way `bootstrap` emits its
    // "start your app" line: the shell prints trailers once at the end of the
    // run, so the next step is the last thing on screen.
    yield* emitSuccessTrailer(
      `Deploy it with ${aqua(`supabase experimental workers push ${name}`)}.\n`,
    );
  }).pipe(Effect.ensuring(telemetryState.flush));
});
