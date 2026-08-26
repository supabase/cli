import { join, relative, sep } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyRenderWorkerDetails } from "../workers.format.ts";
import {
  legacyEmitWorkersMachineOutput,
  legacyWorkersMachineOutputRequested,
} from "../workers.output.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
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
  DEFAULT_WORKER_RUNTIME,
  DEFAULT_WORKER_SIZE,
  parseWorkerRuntime,
  parseWorkerSize,
  validateWorkerNameMessage,
  vcpuForSize,
  WORKER_RUNTIME_DESCRIPTIONS,
  WORKER_RUNTIMES,
  WORKER_SIZES,
  type WorkerRuntime,
  type WorkerSize,
} from "../../../../shared/workers/worker-runtimes.ts";
import { WORKER_STACKS } from "../../../../shared/workers/worker-stacks.ts";
import {
  MissingWorkerNameError,
  WorkerDirectoryExistsError,
} from "../../../../shared/workers/workers.errors.ts";
import {
  legacyLoadWorkersProject,
  legacyValidateWorkerName,
  type LegacyWorkersProject,
} from "../workers.shared.ts";
import type { LegacyWorkersNewFlags } from "./new.command.ts";

/**
 * `supabase workers new [name]` — scaffold `supabase/workers/<name>/` from the
 * chosen runtime's starter files and record the choice in `config.toml`.
 * Nothing is deployed; this is entirely local-disk work.
 *
 * The name, runtime and size are all resolved *before* anything is written, so a
 * cancelled prompt leaves nothing behind for this worker at all.
 */

/** `values`, with `defaultValue` first, so a prompt pre-selects what it shows first. */
function defaultFirst<T>(values: ReadonlyArray<T>, defaultValue: T): Array<T> {
  return [defaultValue, ...values.filter((value) => value !== defaultValue)];
}

/**
 * The worker name, asked for when the command line did not carry one.
 *
 * The name is the one input here that cannot be defaulted — it is the
 * directory, the `config.toml` key and the hostname — so a bare
 * `supabase workers new` asks rather than failing the parse. The prompt
 * validates against everything the command would otherwise refuse a moment
 * later, so a mistyped or already-recorded name is corrected in place instead
 * of ending the run.
 */
const resolveName = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<string>;
  /** `-o json|yaml|toml|env` — stdout belongs to the payload, so do not prompt. */
  readonly machineOutput: boolean;
  readonly project: LegacyWorkersProject;
}) {
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  const output = yield* Output;
  if (output.format === "text" && output.interactive && !options.machineOutput) {
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
      suggestion: "Pass a worker name, for example `supabase workers new api`.",
    }),
  );
});

const resolveRuntime = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<WorkerRuntime>;
  /** `-o json|yaml|toml|env` — stdout belongs to the payload, so do not prompt. */
  readonly machineOutput: boolean;
}) {
  // `--runtime` is a choice flag, so the parser has already rejected anything
  // outside the catalog by the time it gets here.
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  const output = yield* Output;
  if (output.format === "text" && output.interactive && !options.machineOutput) {
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
  /** `-o json|yaml|toml|env` — stdout belongs to the payload, so do not prompt. */
  readonly machineOutput: boolean;
}) {
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  const output = yield* Output;
  if (output.format === "text" && output.interactive && !options.machineOutput) {
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

export const legacyWorkersNew = Effect.fn("legacy.workers.new")(function* (
  flags: LegacyWorkersNewFlags,
) {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const telemetryState = yield* LegacyTelemetryState;
  const runtimeInfo = yield* RuntimeInfo;

  // The telemetry state file is written on every invocation, success or failure.
  yield* Effect.gen(function* () {
    const project = yield* legacyLoadWorkersProject();

    // `-o` leaves `output.format` as `text`, and the prompts go through Clack,
    // which writes its terminal UI to stdout with no stream override — so a
    // prompt would land in front of the payload just as the notices did. Read
    // before the first prompt rather than beside the last, since the name is
    // now asked for too.
    const machineOutput = yield* legacyWorkersMachineOutputRequested();

    const name = yield* resolveName({ explicit: flags.name, machineOutput, project });
    yield* legacyValidateWorkerName(name);

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

    // Resolved before anything is written, so cancelling either prompt leaves
    // nothing behind — the name included. With a machine format requested there
    // is nowhere to ask, so the defaults stand.
    const runtime = yield* resolveRuntime({ explicit: flags.runtime, machineOutput });
    const size = yield* resolveSize({ explicit: flags.size, machineOutput });

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
      const shown = displayPath(project.projectRoot, destination);
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

    const sourceDisplay = displayPath(project.projectRoot, destination);

    const payload = {
      worker_name: name,
      runtime,
      size,
      vcpu: vcpuForSize(size),
      source: sourceDisplay,
      config_path: project.configPath,
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

    // Leads with a declarative line the way every other scaffold does
    // (`functions new`: "Created new Function at supabase/functions/hello"),
    // then the details. Guidance goes in a closing sentence rather than a
    // pseudo-row, since no other command puts a next step inside its output
    // table.
    yield* output.raw(`Created new Worker at ${sourceDisplay}\n`);
    yield* output.raw(
      legacyRenderWorkerDetails([
        ["Runtime", runtime],
        ["Size", `${size} (${vcpuForSize(size)} vCPU)`],
        ["Access", "public"],
      ]),
    );
    yield* output.raw(`Deploy it with supabase workers push ${name}.\n`);
  }).pipe(Effect.ensuring(telemetryState.flush));
});
