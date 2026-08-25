import { join } from "node:path";
import { loadProjectConfig } from "@supabase/config/effect";
import { Effect, FileSystem, Option } from "effect";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
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
  /** `supabase/workers/`, where every worker lives unless it names a `source`. */
  readonly workersDir: string;
}

export const legacyLoadWorkersProject = Effect.fnUntraced(function* () {
  const cliConfig = yield* LegacyCliConfig;
  const projectRoot = cliConfig.workdir;
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
  // `loadProjectConfig` returns null when the directory holds no project yet,
  // which is what lets `workers new` scaffold into a bare one.
  const loaded = yield* loadProjectConfig(projectRoot, { tomlOnly: true });
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
  /** Where its code would live, honouring `[workers.<name>] source`. */
  readonly sourceDir: string;
  /**
   * Whether anything local actually establishes {@link sourceDir}.
   *
   * `sourceDir` is always computable — with no entry it falls back to the default
   * directory — so it cannot on its own tell a worker whose code is on this
   * machine from one deployed out of another checkout. Commands that print local
   * paths need that difference before they state one as fact.
   */
  readonly sourceExists: boolean;
}

/**
 * Effectful because resolving `sourceDir` confines it to the project, and that
 * verdict needs the filesystem: `source` comes from a committed `config.toml`,
 * and a directory inside the project can symlink anywhere outside it.
 */
/**
 * As {@link legacyDescribeWorker}, but never failing on the source path.
 *
 * For commands that only *report* on local state — `status` and `delete` — where
 * the source is a detail of the output, not a prerequisite. Making confinement
 * mandatory there stranded the remote worker: a `source` that resolves outside
 * the project (an in-project directory that became a symlink, say) failed the
 * describe before either API call, so `delete` could not remove a worker whose
 * local files it was never going to touch.
 *
 * `push` keeps the strict version, because there the source *is* what gets
 * packaged and uploaded.
 */
export const legacyDescribeWorkerForReporting = Effect.fnUntraced(function* (
  project: LegacyWorkersProject,
  name: string,
) {
  const described = yield* legacyDescribeWorker(project, name).pipe(Effect.option);
  if (Option.isSome(described)) {
    return described.value;
  }
  // The path is unusable, which for reporting purposes reads the same as having
  // nothing local at all.
  return {
    name,
    entry: project.section.workers[name],
    defaultDir: workerDir(project.projectRoot, name),
    sourceDir: workerDir(project.projectRoot, name),
    sourceExists: false,
  } satisfies LegacyResolvedWorker;
});

export const legacyDescribeWorker = Effect.fnUntraced(function* (
  project: LegacyWorkersProject,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const entry = project.section.workers[name];
  const defaultDir = workerDir(project.projectRoot, name);
  const sourceDir = yield* workerSourceDir({
    projectRoot: project.projectRoot,
    defaultDir,
    name,
    configuredSource: entry?.source,
  });
  const info = yield* fs.stat(sourceDir).pipe(Effect.option);

  return {
    name,
    entry,
    defaultDir,
    sourceDir,
    sourceExists: Option.isSome(info) && info.value.type === "Directory",
  } satisfies LegacyResolvedWorker;
});

/** Reject a name that could never be a worker, before acting on it. */
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
