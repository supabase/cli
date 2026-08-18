import { join } from "node:path";
import { findProjectPaths, loadProjectConfig } from "@supabase/config";
import { Effect, Option } from "effect";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  readWorkersSection,
  type WorkerEntry,
  type WorkersSection,
} from "../../../shared/workers/worker-config.ts";
import {
  displayPath,
  inferWorkerNameFromCwd,
  resolveWorkersRoot,
  workerDir,
  workersRootDir,
  workerSourceDir,
} from "../../../shared/workers/worker-paths.ts";
import {
  validateWorkerNameMessage,
  workerNameRequirement,
} from "../../../shared/workers/worker-runtimes.ts";
import {
  InvalidWorkerNameError,
  MissingWorkerNameError,
} from "../../../shared/workers/workers.errors.ts";

/**
 * What every `supabase workers` command needs before it does anything: where
 * the project is, what `[workers]` says, and which worker is being acted on.
 *
 * The project is found by walking up for `supabase/config.toml`, the same
 * anchor `supabase functions new` uses — so the commands work from anywhere
 * inside the project rather than only from its root. A directory with no
 * project yet falls back to the current one, which is what lets `workers new`
 * scaffold in a bare directory.
 */

export interface WorkersProject {
  readonly cwd: string;
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly configPath: string;
  readonly section: WorkersSection;
  /** `[workers] root`, validated. */
  readonly root: string;
  /** `supabase/<root>/`. */
  readonly rootDir: string;
}

export const loadWorkersProject = Effect.fnUntraced(function* () {
  const runtimeInfo = yield* RuntimeInfo;
  const paths = yield* findProjectPaths(runtimeInfo.cwd);
  const projectRoot = paths === null ? runtimeInfo.cwd : paths.projectRoot;
  const supabaseDir = paths?.supabaseDir ?? join(projectRoot, "supabase");
  const configPath = paths?.configPath ?? join(supabaseDir, "config.toml");

  const loaded = paths === null ? null : yield* loadProjectConfig(projectRoot);
  const section = readWorkersSection(loaded?.config.workers);
  const root = yield* resolveWorkersRoot(section.root);

  return {
    cwd: runtimeInfo.cwd,
    projectRoot,
    supabaseDir,
    configPath,
    section,
    root,
    rootDir: workersRootDir(projectRoot, root),
  } satisfies WorkersProject;
});

export interface ResolvedWorker {
  readonly name: string;
  readonly entry: WorkerEntry | undefined;
  /** The worker's default directory, `supabase/<root>/<name>/`. */
  readonly defaultDir: string;
  /** Where its code actually lives, honouring `[workers.<name>] source`. */
  readonly sourceDir: string;
}

export function describeWorker(project: WorkersProject, name: string): ResolvedWorker {
  const entry = project.section.workers[name];
  const defaultDir = workerDir(project.projectRoot, project.root, name);
  return {
    name,
    entry,
    defaultDir,
    sourceDir: workerSourceDir(project.projectRoot, defaultDir, entry?.source),
  };
}

/**
 * Which worker a command acts on: the name given, or the one inferred from the
 * current directory when it sits directly inside the workers root. The
 * directory is the mapping, so an unqualified invocation from inside a worker
 * needs nothing else.
 */
export const resolveWorkerName = Effect.fnUntraced(function* (options: {
  readonly project: WorkersProject;
  readonly name: Option.Option<string>;
  /** The subcommand, for the "pass one" suggestion. */
  readonly command: string;
}) {
  if (Option.isSome(options.name)) {
    const invalid = validateWorkerNameMessage(options.name.value);
    if (invalid !== undefined) {
      return yield* Effect.fail(
        new InvalidWorkerNameError({
          detail: `"${options.name.value}" is not a valid worker name. ${invalid}`,
          suggestion: "Worker names become hostnames, so they must be DNS labels.",
        }),
      );
    }
    return options.name.value;
  }

  const inferred = inferWorkerNameFromCwd(options.project.cwd, options.project.rootDir);
  if (inferred !== undefined && validateWorkerNameMessage(inferred) === undefined) {
    return inferred;
  }

  return yield* Effect.fail(
    new MissingWorkerNameError({
      detail:
        inferred === undefined
          ? "No worker name was given, and this directory is not a worker directory."
          : `No worker name was given, and "${inferred}" is not a usable one. ${workerNameRequirement}`,
      suggestion: `Run it from inside ${displayPath(
        options.project.cwd,
        options.project.rootDir,
      )}/<name>/, or pass a name: \`supabase workers ${options.command} <name>\`.`,
    }),
  );
});
