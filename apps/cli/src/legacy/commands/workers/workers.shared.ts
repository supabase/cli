import { join } from "node:path";
import { loadProjectConfig } from "@supabase/config";
import { Effect, FileSystem } from "effect";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import {
  readWorkersSection,
  type WorkerEntry,
  type WorkersSection,
} from "../../../shared/workers/worker-config.ts";
import {
  resolveWorkersRoot,
  workerDir,
  workersRootDir,
  workerSourceDir,
} from "../../../shared/workers/worker-paths.ts";
import { validateWorkerNameMessage } from "../../../shared/workers/worker-runtimes.ts";
import { InvalidWorkerNameError } from "../../../shared/workers/workers.errors.ts";

/**
 * What every `supabase workers` command needs before it does anything: where
 * the project is, what `[workers]` says, and which worker is being acted on.
 *
 * The project directory is `LegacyCliConfig.workdir` rather than an ancestor
 * walk from the current directory. That is the resolved workdir every other
 * legacy command acts on — `--workdir`/`SUPABASE_WORKDIR` when given, else the
 * ancestor walk Go's own `getProjectRoot` performs — so `supabase workers`
 * answers to the same flag as its siblings instead of inventing a second notion
 * of "which project".
 */

export interface LegacyWorkersProject {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly configPath: string;
  readonly section: WorkersSection;
  /** `[workers] root`, validated. */
  readonly root: string;
  /** `supabase/<root>/`. */
  readonly rootDir: string;
}

export const legacyLoadWorkersProject = Effect.fnUntraced(function* () {
  const cliConfig = yield* LegacyCliConfig;
  const projectRoot = cliConfig.workdir;
  const supabaseDir = join(projectRoot, "supabase");

  // `loadProjectConfig` returns null when the directory holds no project yet,
  // which is what lets `workers new` scaffold into a bare one.
  const loaded = yield* loadProjectConfig(projectRoot);
  const section = readWorkersSection(loaded?.config.workers);
  const root = yield* resolveWorkersRoot(section.root);

  return {
    projectRoot,
    supabaseDir,
    configPath: loaded?.path ?? join(supabaseDir, "config.toml"),
    section,
    root,
    rootDir: workersRootDir(projectRoot, root),
  } satisfies LegacyWorkersProject;
});

export interface LegacyResolvedWorker {
  readonly name: string;
  readonly entry: WorkerEntry | undefined;
  /** The worker's default directory, `supabase/<root>/<name>/`. */
  readonly defaultDir: string;
  /** Where its code actually lives, honouring `[workers.<name>] source`. */
  readonly sourceDir: string;
}

export function legacyDescribeWorker(
  project: LegacyWorkersProject,
  name: string,
): LegacyResolvedWorker {
  const entry = project.section.workers[name];
  const defaultDir = workerDir(project.projectRoot, project.root, name);
  return {
    name,
    entry,
    defaultDir,
    sourceDir: workerSourceDir(project.projectRoot, defaultDir, entry?.source),
  };
}

/** Reject a name the CLI could never have written, before acting on it. */
export const legacyValidateWorkerName = Effect.fnUntraced(function* (name: string) {
  const invalid = validateWorkerNameMessage(name);
  if (invalid !== undefined) {
    return yield* Effect.fail(
      new InvalidWorkerNameError({
        detail: `"${name}" is not a valid worker name. ${invalid}`,
        suggestion: "Worker names become hostnames, so they must be DNS labels.",
      }),
    );
  }
  return name;
});

/**
 * Every worker in the project, for a command given no names: the directories
 * under the workers root, unioned with the `[workers.<name>]` entries, since a
 * worker with a `source` lives outside that root and would otherwise be missed.
 *
 * Sorted, so a bare `push` deploys in a stable order rather than whatever the
 * filesystem happened to return.
 */
export const legacyDiscoverWorkerNames = Effect.fnUntraced(function* (
  project: LegacyWorkersProject,
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(project.rootDir).pipe(Effect.orElseSucceed(() => []));

  const scaffolded: Array<string> = [];
  for (const entry of entries) {
    const info = yield* fs.stat(join(project.rootDir, entry)).pipe(Effect.option);
    if (info._tag === "Some" && info.value.type === "Directory") {
      scaffolded.push(entry);
    }
  }

  return [...new Set([...scaffolded, ...Object.keys(project.section.workers)])]
    .filter((name) => validateWorkerNameMessage(name) === undefined)
    .sort();
});
