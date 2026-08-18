import { dirname, join, relative } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { Random } from "../../../../shared/runtime/random.service.ts";
import { writeWorkerEntry } from "../../../../shared/workers/worker-config.ts";
import { displayPath, resolveWorkerSource } from "../../../../shared/workers/worker-paths.ts";
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
  InvalidWorkerNameError,
  UnknownWorkerRuntimeError,
  UnknownWorkerSizeError,
  WorkerDirectoryExistsError,
} from "../../../../shared/workers/workers.errors.ts";
import { loadWorkersProject } from "../workers.shared.ts";
import type { WorkersNewFlags } from "./new.command.ts";

/**
 * `supabase workers new [name]` — scaffold `supabase/<root>/<name>/` from the
 * chosen runtime's starter files and record the choice in `config.toml`.
 * Nothing is deployed; this is entirely local-disk work.
 *
 * The runtime and size are resolved *before* anything is written, so a
 * cancelled prompt leaves nothing behind for this worker at all — including the
 * name, which is only generated once both questions have been answered.
 */

/** Adjective pool for an auto-assigned name, when no name is given. */
const NAME_WORDS = [
  "agile",
  "amber",
  "apex",
  "astral",
  "atomic",
  "aurora",
  "bold",
  "bright",
  "brisk",
  "calm",
  "cipher",
  "cobalt",
  "cosmic",
  "crimson",
  "delta",
  "echo",
  "ember",
  "flint",
  "flux",
  "frosty",
  "glide",
  "halo",
  "helix",
  "ionic",
  "jade",
  "keen",
  "kinetic",
  "lithe",
  "lucid",
  "lunar",
  "maple",
  "mist",
  "mystic",
  "neon",
  "nimble",
  "noble",
  "nomad",
  "nova",
  "onyx",
  "opal",
  "orbit",
  "prism",
  "quartz",
  "rapid",
  "reef",
  "rogue",
  "sage",
  "sharp",
  "silver",
  "solar",
  "sonic",
  "spark",
  "steady",
  "stellar",
  "summit",
  "surge",
  "swift",
] as const;

const generateWorkerName = Effect.fnUntraced(function* () {
  const random = yield* Random;
  // Six bytes, split so the word and the number are drawn independently.
  const hex = yield* random.randomHex(6);
  const word = NAME_WORDS[Number.parseInt(hex.slice(0, 6), 16) % NAME_WORDS.length];
  const suffix = 10000 + (Number.parseInt(hex.slice(6, 12), 16) % 90000);
  return `worker-${word}-${suffix}`;
});

/** `values`, with `defaultValue` first, so a prompt pre-selects what it shows first. */
function defaultFirst<T>(values: ReadonlyArray<T>, defaultValue: T): Array<T> {
  return [defaultValue, ...values.filter((value) => value !== defaultValue)];
}

const resolveRuntime = Effect.fnUntraced(function* (options: {
  readonly explicit: Option.Option<WorkerRuntime>;
  readonly recorded: string | undefined;
}) {
  // `--runtime` is a choice flag, so the parser has already rejected anything
  // outside the catalog by the time it gets here.
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  if (options.recorded !== undefined) {
    const recorded = parseWorkerRuntime(options.recorded);
    if (recorded === undefined) {
      return yield* Effect.fail(
        new UnknownWorkerRuntimeError({
          detail: `supabase/config.toml records an unknown runtime "${options.recorded}".`,
          suggestion: `Set it to one of: ${WORKER_RUNTIMES.join(", ")}, or pass --runtime.`,
        }),
      );
    }
    return recorded;
  }

  const output = yield* Output;
  if (output.format === "text" && output.interactive) {
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
  readonly recorded: string | undefined;
}) {
  if (Option.isSome(options.explicit)) {
    return options.explicit.value;
  }

  if (options.recorded !== undefined) {
    const recorded = parseWorkerSize(options.recorded);
    if (recorded === undefined) {
      return yield* Effect.fail(
        new UnknownWorkerSizeError({
          detail: `supabase/config.toml records an unknown size "${options.recorded}".`,
          suggestion: `Set it to one of: ${WORKER_SIZES.join(", ")}, or pass --size.`,
        }),
      );
    }
    return recorded;
  }

  const output = yield* Output;
  if (output.format === "text" && output.interactive) {
    const selected = yield* output.promptSelect(
      "Which instance size should this worker use?",
      defaultFirst([...WORKER_SIZES], DEFAULT_WORKER_SIZE).map((size) => ({
        value: size,
        label: `${size} · ${vcpuForSize(size)} vCPU`,
      })),
    );
    return parseWorkerSize(selected) ?? DEFAULT_WORKER_SIZE;
  }

  return DEFAULT_WORKER_SIZE;
});

const isNonEmptyDirectory = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  return entries.length > 0;
});

export const workersNew = Effect.fn("workers.new")(function* (flags: WorkersNewFlags) {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;

  yield* output.intro("Create worker");

  const project = yield* loadWorkersProject();

  if (Option.isSome(flags.name)) {
    const invalid = validateWorkerNameMessage(flags.name.value);
    if (invalid !== undefined) {
      return yield* Effect.fail(
        new InvalidWorkerNameError({
          detail: `"${flags.name.value}" is not a valid worker name. ${invalid}`,
          suggestion: "Worker names become hostnames, so they must be DNS labels.",
        }),
      );
    }
  }

  // A named worker may already have a `[workers.<name>]` entry — hand-written,
  // or left over from a `new` whose directory was since deleted. Its recorded
  // choices become this run's defaults instead of re-asking questions
  // config.toml has already answered.
  const recorded = Option.isSome(flags.name)
    ? project.section.workers[flags.name.value]
    : undefined;
  // Only worth saying when a recorded value is actually about to answer for a
  // flag the user omitted. An entry that is present but empty, or one whose
  // every key was overridden on the command line, contributes nothing.
  const inherits =
    (recorded?.runtime !== undefined && Option.isNone(flags.runtime)) ||
    (recorded?.size !== undefined && Option.isNone(flags.size)) ||
    (recorded?.source !== undefined && Option.isNone(flags.source));
  if (inherits && Option.isSome(flags.name)) {
    yield* output.info(
      `Reusing the existing config.toml entry for "${flags.name.value}". Pass --runtime/--size/--source to override.`,
    );
  }

  // Resolved before anything is written, so cancelling either prompt leaves
  // nothing behind — the name included.
  const runtime = yield* resolveRuntime({ explicit: flags.runtime, recorded: recorded?.runtime });
  const size = yield* resolveSize({ explicit: flags.size, recorded: recorded?.size });

  const name = Option.isSome(flags.name) ? flags.name.value : yield* generateWorkerName();
  if (Option.isNone(flags.name)) {
    yield* output.info(`Auto-assigned the name "${name}".`);
  }

  // An explicit --source always wins; absent one, a recorded `source` keeps the
  // scaffold where config.toml already says the code lives rather than
  // defaulting to the workers directory out from under it.
  // Validated before anything is written: `--force` deletes this directory
  // outright, so a value naming the project root or `supabase/` must never get
  // as far as the removal below.
  const destination = Option.isSome(flags.source)
    ? yield* resolveWorkerSource({
        projectRoot: project.projectRoot,
        cwd: project.cwd,
        raw: flags.source.value,
      })
    : recorded?.source === undefined
      ? join(project.rootDir, name)
      : yield* resolveWorkerSource({
          projectRoot: project.projectRoot,
          cwd: project.projectRoot,
          raw: recorded.source,
        });

  if (yield* isNonEmptyDirectory(destination)) {
    if (!flags.force) {
      return yield* Effect.fail(
        new WorkerDirectoryExistsError({
          detail: `${displayPath(project.cwd, destination)} already exists and is not empty.`,
          suggestion: `Replace it with \`supabase workers new ${name} --force\`, or pick a different name.`,
        }),
      );
    }
    // Replaced wholesale rather than merged: a re-run with a different runtime
    // would otherwise leave the previous runtime's files mixed in with the new
    // ones.
    yield* fs.remove(destination, { recursive: true });
  }

  yield* fs.makeDirectory(dirname(destination), { recursive: true });
  yield* fs.makeDirectory(destination, { recursive: true });
  // config.toml lives in supabase/, which may not exist yet when --source puts
  // the worker elsewhere in the project.
  yield* fs.makeDirectory(project.supabaseDir, { recursive: true });

  for (const [filename, contents] of Object.entries(WORKER_STACKS[runtime])) {
    yield* fs.writeFileString(join(destination, filename), contents);
  }

  const source = Option.isSome(flags.source)
    ? relative(project.projectRoot, destination)
    : recorded?.source;

  yield* writeWorkerEntry({
    configPath: project.configPath,
    name,
    existingWorkers: project.section.workers,
    patch: {
      runtime,
      size,
      ...(source === undefined ? {} : { source }),
    },
  });

  const sourceDisplay = displayPath(project.cwd, destination);

  yield* output.success("Created worker.", {
    worker_name: name,
    runtime,
    size,
    vcpu: vcpuForSize(size),
    source: sourceDisplay,
    config_path: project.configPath,
  });

  if (output.format === "text") {
    yield* output.info(`source    ${sourceDisplay}`);
    yield* output.info(`runtime   ${runtime}`);
    yield* output.info(`size      ${size} · ${vcpuForSize(size)} vCPU`);
    yield* output.info(
      `access    ${runtime === "sandbox" ? "private (no HTTP endpoint)" : "public"}`,
    );
  }

  yield* output.outro(`Next: supabase workers push ${name}`);
});
