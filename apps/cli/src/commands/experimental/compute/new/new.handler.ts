import { Effect, FileSystem, Option, Path } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { emitSuccessTrailer } from "../../../../shared/cli/success-trailer.ts";
import { aqua, bold } from "../../../../command-internal/colors.ts";
import { validateWorkdirIsDirectory } from "../../../../command-internal/workdir-validation.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { renderComputeDetails } from "../compute.format.ts";
import { emitComputeMachineOutput, computeMachineOutputRequested } from "../compute.output.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import {
  commitComputeEntry,
  planComputeEntry,
  ComputeAlreadyConfiguredError,
} from "../../../../shared/compute/compute-config.ts";
import {
  confineComputePath,
  displayPath,
  resolveComputeSource,
} from "../../../../shared/compute/compute-paths.ts";
import {
  DEFAULT_COMPUTE_EXPOSURE,
  DEFAULT_COMPUTE_INSTANCES,
  DEFAULT_COMPUTE_RUNTIME,
  DEFAULT_COMPUTE_SIZE,
  parseComputeExposure,
  parseComputeRuntime,
  parseComputeSize,
  validateComputeNameMessage,
  vcpuForSize,
  COMPUTE_EXPOSURE_DESCRIPTIONS,
  COMPUTE_EXPOSURES,
  COMPUTE_RUNTIME_DESCRIPTIONS,
  COMPUTE_RUNTIMES,
  COMPUTE_SIZES,
  type ComputeExposure,
  type ComputeRuntime,
  type ComputeSize,
} from "../../../../shared/compute/compute-runtimes.ts";
import { COMPUTE_STACKS } from "../../../../shared/compute/compute-stacks.ts";
import {
  MissingComputeNameError,
  ComputeDirectoryExistsError,
} from "../../../../shared/compute/compute.errors.ts";
import {
  loadComputeProjectForEntryWrite,
  validateComputeName,
  type ComputeProject,
} from "../compute.shared.ts";
import type { ComputeNewFlags } from "./new.command.ts";
import { ComputeNewWorkdirError } from "./new.errors.ts";

/**
 * `supabase compute new [name]` — scaffold `supabase/compute/<name>/` from the
 * chosen runtime's starter files and record the choice in `config.toml`.
 * Nothing is deployed; this is entirely local-disk work.
 *
 * The name, runtime, size and exposure are all resolved *before* anything is
 * written, so a cancelled prompt leaves nothing behind for this compute at all.
 * `--instances` is recorded rather than resolved: it has no prompt, and it only
 * reaches `config.toml` when it differs from the default.
 */

/** `values`, with `defaultValue` first, so a prompt pre-selects what it shows first. */
function defaultFirst<T>(values: ReadonlyArray<T>, defaultValue: T): Array<T> {
  return [defaultValue, ...values.filter((value) => value !== defaultValue)];
}

/**
 * Whether this run has a terminal to ask on. `-o json|yaml|toml|env` leaves
 * `output.format` as `text` but still writes Clack's UI to stdout, so it's as
 * non-interactive as a redirected stdout. `output.interactive` only tracks
 * stdout, so piped stdin also needs `tty.stdinIsTty` — a prompt is only
 * answerable from a keyboard.
 */
const canPromptFor = Effect.fnUntraced(function* (machineOutput: boolean) {
  const output = yield* Output;
  const tty = yield* Tty;
  return output.format === "text" && output.interactive && !machineOutput && tty.stdinIsTty;
});

/**
 * The compute name, asked for when the command line did not carry one.
 *
 * The name can't be defaulted — it's the directory, the config key, and the
 * hostname — so a bare invocation asks rather than failing the parse. The
 * prompt validates the same rules the command would otherwise enforce later.
 */
const resolveName = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<string>;
  /** Whether there is a terminal to ask on — see `canPromptFor`. */
  readonly canPrompt: boolean;
  readonly project: ComputeProject;
}) {
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  if (options.canPrompt) {
    const output = yield* Output;
    return yield* output.promptText("What should this compute be called?", {
      validate: (value) => {
        const invalid = validateComputeNameMessage(value);
        if (invalid !== undefined) {
          return invalid;
        }
        return options.project.section.compute[value] === undefined
          ? undefined
          : `"${value}" is already configured in ${options.project.configPath}.`;
      },
    });
  }

  return yield* new MissingComputeNameError({
    detail: "Compute name is required in non-interactive mode.",
    suggestion: "Pass a compute name, for example `supabase compute new api`.",
  });
});

const resolveRuntime = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<ComputeRuntime>;
  /** Whether there is a terminal to ask on — see `canPromptFor`. */
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
      "Which runtime should this compute use?",
      defaultFirst([...COMPUTE_RUNTIMES], DEFAULT_COMPUTE_RUNTIME).map((runtime) => ({
        value: runtime,
        label: runtime,
        hint: COMPUTE_RUNTIME_DESCRIPTIONS[runtime],
      })),
    );
    return parseComputeRuntime(selected) ?? DEFAULT_COMPUTE_RUNTIME;
  }

  return DEFAULT_COMPUTE_RUNTIME;
});

const resolveSize = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<ComputeSize>;
  /** Whether there is a terminal to ask on — see `canPromptFor`. */
  readonly canPrompt: boolean;
}) {
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  if (options.canPrompt) {
    const output = yield* Output;
    const selected = yield* output.promptSelect(
      "Which instance size should this compute use?",
      defaultFirst([...COMPUTE_SIZES], DEFAULT_COMPUTE_SIZE).map((size) => ({
        value: size,
        label: `${size} (${vcpuForSize(size)} vCPU)`,
      })),
    );
    return parseComputeSize(selected) ?? DEFAULT_COMPUTE_SIZE;
  }

  return DEFAULT_COMPUTE_SIZE;
});

/**
 * Recorded on every scaffold, not just when asked for: `push` sends a
 * complete spec each time, so an absent `exposure` in `config.toml` deploys
 * public on the next bare `push`. Writing the value down, default included,
 * is what makes `--exposure private` stick.
 */
const resolveExposure = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<ComputeExposure>;
  /** Whether there is a terminal to ask on — see `canPromptFor`. */
  readonly canPrompt: boolean;
}) {
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  if (options.canPrompt) {
    const output = yield* Output;
    const selected = yield* output.promptSelect(
      "Should this compute be reachable from the internet?",
      defaultFirst([...COMPUTE_EXPOSURES], DEFAULT_COMPUTE_EXPOSURE).map((exposure) => ({
        value: exposure,
        label: exposure,
        hint: COMPUTE_EXPOSURE_DESCRIPTIONS[exposure],
      })),
    );
    return parseComputeExposure(selected) ?? DEFAULT_COMPUTE_EXPOSURE;
  }

  return DEFAULT_COMPUTE_EXPOSURE;
});

/**
 * The instance count to record, and whether to record it at all.
 *
 * Not prompted for, unlike the other dials — nobody knows the right instance
 * count while scaffolding. `undefined` (write no key) for the default, since
 * an absent `instances` and `instances = 1` mean the same thing to `push`; a
 * `0` is a real choice (scale to nothing), so it's always written.
 */
function recordedInstances(explicit: Option.Option<number>): number | undefined {
  const instances = Option.getOrUndefined(explicit);
  return instances === undefined || instances === DEFAULT_COMPUTE_INSTANCES ? undefined : instances;
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

export const computeNew = Effect.fn("compute.new")(function* (flags: ComputeNewFlags) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const runtimeInfo = yield* RuntimeInfo;
  const cliSettings = yield* CommandSettings;

  // The telemetry state file is written on every invocation, success or failure.
  yield* Effect.gen(function* () {
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new ComputeNewWorkdirError({ message: error.message })),
    );

    const project = yield* loadComputeProjectForEntryWrite();

    // Decided once, before the first prompt rather than beside the last, since
    // the name is now asked for too — every prompt below shares the answer.
    const machineOutput = yield* computeMachineOutputRequested();
    const canPrompt = yield* canPromptFor(machineOutput);

    const name = yield* resolveName({ explicit: flags.name, canPrompt, project });
    yield* validateComputeName(name);

    // Refused before anything is asked or written. `new` creates a compute;
    // changing one that already exists is a `config.toml` edit, and the file is
    // the user's. Checking here rather than only in `planComputeEntry` means the
    // runtime and size prompts never run for a name that was going to be
    // refused anyway; the name prompt rejects it up front for the same reason.
    if (project.section.compute[name] !== undefined) {
      return yield* new ComputeAlreadyConfiguredError({
        detail: `"${name}" is already configured in ${project.configPath}.`,
        suggestion: `Edit [compute.${name}] in ${project.configPath} yourself, or pick a different compute name.`,
      });
    }

    // Resolved before anything is written, so cancelling any prompt leaves nothing
    // behind. With nowhere to ask, the defaults stand — only the name has no fallback.
    const runtime = yield* resolveRuntime({ explicit: flags.runtime, canPrompt });
    const size = yield* resolveSize({ explicit: flags.size, canPrompt });
    const exposure = yield* resolveExposure({ explicit: flags.exposure, canPrompt });
    const instances = recordedInstances(flags.instances);

    // Validated before anything is written: this is the directory the starter files
    // land in, so a value naming the project root, `supabase/`, or anywhere outside
    // the project must never reach the write below. `--source` resolves against the
    // directory the user typed it in, the way a shell would: `--source generated`
    // from `apps/web` means `apps/web/generated`.
    const destination = Option.isSome(flags.source)
      ? yield* resolveComputeSource({
          projectRoot: project.projectRoot,
          cwd: runtimeInfo.cwd,
          raw: flags.source.value,
        })
      : yield* confineComputePath({
          projectRoot: project.projectRoot,
          target: path.join(project.computeDir, name),
          subject: `The default directory for "${name}"`,
          // The default directory is `supabase/compute/<name>` with a validated
          // name, so only a symlink escaping the project can reach this
          // failure — which is what the suggestion names.
          suggestion:
            "supabase/compute, or a directory above it, is a symlink leading outside the project. Replace it with a real directory, or pass --source to scaffold somewhere else inside the project.",
        });

    // Nothing here replaces what is already on disk: scaffolding over an existing
    // directory would have to delete it first, which isn't this command's job — it
    // names what's in the way and leaves the choice to the user.
    if (!(yield* destinationIsFree(destination))) {
      // Absolute when `--workdir` was set explicitly, since a project-root-relative
      // path would be misleading once `--workdir` differs from cwd.
      const shown = cliSettings.explicitWorkdir
        ? destination
        : displayPath(path, project.projectRoot, destination);
      return yield* new ComputeDirectoryExistsError({
        detail: `${shown} already exists and is not empty.`,
        suggestion: `Remove ${shown} yourself if you meant to replace it, or pick a different compute name.`,
      });
    }

    // Recorded as forward slashes whatever platform wrote it: `config.toml` is
    // shared, and `path.relative` yields backslashes on Windows that POSIX
    // resolvers elsewhere would read as a literal filename character.
    const source = Option.isSome(flags.source)
      ? path.relative(project.projectRoot, destination).split(path.sep).join("/")
      : undefined;

    // Planned before anything is written: every way this can fail is knowable
    // from the current config.toml, so finding out afterwards would leave a
    // scaffold on disk that nothing records.
    const configWrite = yield* planComputeEntry({
      configPath: project.configPath,
      name,
      existingCompute: project.section.compute,
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

    for (const [filename, contents] of Object.entries(COMPUTE_STACKS[runtime])) {
      yield* fs.writeFileString(path.join(destination, filename), contents);
    }

    yield* commitComputeEntry(configWrite);

    // Relative to the project root when the workdir was defaulted, since it also
    // reads as relative to the terminal the command ran from. An explicit
    // `--workdir` breaks that — the project root can be nowhere near the actual
    // cwd — so the absolute path is used instead.
    const sourceDisplay = cliSettings.explicitWorkdir
      ? destination
      : displayPath(path, project.projectRoot, destination);

    const payload = {
      compute_name: name,
      runtime,
      size,
      vcpu: vcpuForSize(size),
      exposure,
      // The count a deploy will use, whether or not it was written down — a
      // payload that omitted it for the default would read as "unknown" rather
      // than "one".
      instances: instances ?? DEFAULT_COMPUTE_INSTANCES,
      source: sourceDisplay,
      config_path: project.configPath,
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

    // Leads with a declarative line the way every other scaffold does
    // (`functions new`: "Created new Function at supabase/functions/hello"),
    // then the details. Guidance goes in a closing sentence rather than a
    // pseudo-row, since no other command puts a next step inside its output
    // table.
    yield* output.raw(`Created new Compute at ${bold(sourceDisplay, process.stdout)}\n`);
    yield* output.raw(
      renderComputeDetails([
        ["Runtime", runtime],
        ["Size", `${size} (${vcpuForSize(size)} vCPU)`],
        ["Access", exposure],
        // `declared`, the way `compute status` labels the same number: nothing
        // is running yet, so a bare count would read as a live tally.
        ["Instances", `${instances ?? DEFAULT_COMPUTE_INSTANCES} declared`],
      ]),
    );
    // On the success trailer rather than inline, the way `bootstrap` emits its
    // "start your app" line: the shell prints trailers once at the end of the
    // run, so the next step is the last thing on screen.
    yield* emitSuccessTrailer(`Deploy it with ${aqua(`supabase compute push ${name}`)}.\n`);
  }).pipe(Effect.ensuring(telemetryState.flush));
});
