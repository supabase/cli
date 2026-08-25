import { join } from "node:path";
import { loadCliConfig } from "@supabase/config/effect";
import { Effect, FileSystem, Option } from "effect";
import { LegacyCliSettings } from "../../config/legacy-cli-settings.service.ts";
import {
  readWorkersSection,
  type WorkerEntry,
  type WorkersSection,
} from "../../../shared/workers/worker-config.ts";
import { workerDir, workersDir, workerSourceDir } from "../../../shared/workers/worker-paths.ts";
import { validateWorkerNameMessage } from "../../../shared/workers/worker-runtimes.ts";
import { InvalidWorkerNameError } from "../../../shared/workers/workers.errors.ts";

/**
 * What every `supabase workers` command needs before it does anything: where
 * the project is, what `[workers]` says, and which worker is being acted on.
 *
 * The project directory is `LegacyCliSettings.workdir` rather than an ancestor
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
  /** `supabase/workers/`, where every worker lives unless it names a `source`. */
  readonly workersDir: string;
}

export const legacyLoadWorkersProject = Effect.fnUntraced(function* () {
  const settings = yield* LegacyCliSettings;
  const projectRoot = settings.workdir;
  const supabaseDir = join(projectRoot, "supabase");

  // `tomlOnly`: the entry writer is a TOML text editor. Without this the loader
  // prefers `supabase/config.json` when one exists, `configPath` becomes the
  // JSON file, and `commitWorkerEntry` appends a `[workers.<name>]` table to it
  // — leaving the project config unparseable after the scaffold is on disk.
  // `functions new` avoids the same trap by resolving `supabase/config.toml`
  // directly; this is that, through the loader.
  //
  // A JSON project therefore gets a `config.toml` written beside its
  // `config.json`, which the default loader lists in `ignoredPaths`. That is a
  // known gap: workers are TOML-only until config writing is overhauled.
  //
  // `loadCliConfig` returns null when the directory holds no project yet,
  // which is what lets `workers new` scaffold into a bare one.
  const loaded = yield* loadCliConfig(projectRoot, { tomlOnly: true });
  const section = readWorkersSection(loaded?.config.workers);

  return {
    projectRoot,
    supabaseDir,
    configPath: loaded?.path ?? join(supabaseDir, "config.toml"),
    section,
    workersDir: workersDir(projectRoot),
  } satisfies LegacyWorkersProject;
});

export interface LegacyResolvedWorker {
  readonly name: string;
  readonly entry: WorkerEntry | undefined;
  /** The worker's default directory, `supabase/workers/<name>/`. */
  readonly defaultDir: string;
  /** Where its code actually lives, honouring `[workers.<name>] source`. */
  readonly sourceDir: string;
}

/**
 * Effectful because resolving `sourceDir` confines it to the project, and that
 * verdict needs the filesystem: `source` comes from a committed `config.toml`,
 * and a directory inside the project can symlink anywhere outside it.
 */
export const legacyDescribeWorker = Effect.fnUntraced(function* (
  project: LegacyWorkersProject,
  name: string,
) {
  const entry = project.section.workers[name];
  const defaultDir = workerDir(project.projectRoot, name);
  return {
    name,
    entry,
    defaultDir,
    sourceDir: yield* workerSourceDir({
      projectRoot: project.projectRoot,
      defaultDir,
      name,
      configuredSource: entry?.source,
    }),
  } satisfies LegacyResolvedWorker;
});

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
  const entries = yield* fs.readDirectory(project.workersDir).pipe(Effect.orElseSucceed(() => []));

  const scaffolded: Array<string> = [];
  for (const entry of entries) {
    const info = yield* fs.stat(join(project.workersDir, entry)).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "Directory") {
      scaffolded.push(entry);
    }
  }

  return [...new Set([...scaffolded, ...Object.keys(project.section.workers)])]
    .filter((name) => validateWorkerNameMessage(name) === undefined)
    .sort();
});
