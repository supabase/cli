import { join } from "node:path";
import { findCliProjectPaths, loadCliConfig } from "@supabase/config/effect";
import { Effect, FileSystem, Option, Predicate } from "effect";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { shouldSearchAncestors } from "../../../command-internal/workdir-search.ts";
import {
  readWorkersSection,
  type WorkerEntry,
  type WorkersSection,
} from "../../../shared/workers/worker-config.ts";
import { workerDir, workersDir, workerSourceDir } from "../../../shared/workers/worker-paths.ts";
import { validateWorkerNameMessage } from "../../../shared/workers/worker-runtimes.ts";
import { InvalidWorkerNameError } from "../../../shared/workers/workers.errors.ts";

/**
 * What every `supabase experimental workers` command needs before it does
 * anything: where the project is, what `[workers]` says, and which worker is
 * being acted on.
 *
 * The project directory is `CommandSettings.workdir`, the same resolved
 * workdir every other command acts on, so `workers` answers to the same
 * `--workdir`/`SUPABASE_WORKDIR` flag as its siblings.
 */

export interface WorkersProject {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly configPath: string;
  readonly section: WorkersSection;
  /** `supabase/workers/`, where every worker lives unless it names a `source`. */
  readonly workersDir: string;
}

const loadWorkersProjectWith = Effect.fnUntraced(function* (options: {
  readonly tomlOnly: boolean;
}) {
  const settings = yield* CommandSettings;

  // `tomlOnly` skips the ancestor search (redundant with the default
  // resolution); the JSON-capable read needs it so a config.json-only project
  // run from a subdirectory is still found. `projectRoot` is derived from the
  // same search, not `settings.workdir`, so a climb takes `configPath` with it
  // — otherwise a discovered ancestor's `[workers.*]` entries would resolve
  // `source` against the wrong directory.
  const search = options.tomlOnly ? false : shouldSearchAncestors(settings);
  const paths = yield* findCliProjectPaths(settings.workdir, { search });
  const projectRoot = paths?.projectRoot ?? settings.workdir;
  const supabaseDir = join(projectRoot, "supabase");

  // `search: false`: the climb (if any) already happened above; reading
  // `projectRoot`'s own config.toml again must never climb a second time.
  const loaded = yield* loadCliConfig(projectRoot, { tomlOnly: options.tomlOnly, search: false });
  const section = readWorkersSection(loaded?.config.workers);

  return {
    projectRoot,
    supabaseDir,
    configPath: loaded?.path ?? join(supabaseDir, "config.toml"),
    section,
    workersDir: workersDir(projectRoot),
  } satisfies WorkersProject;
});

/**
 * The project as a reader sees it, following the loader's normal
 * JSON-over-TOML selection.
 *
 * A command that only reads `[workers.*]` still has to honour `config.json`,
 * or a JSON project deploys with a guessed runtime and default size/instance
 * counts instead of the ones it configured.
 */
export const loadWorkersProject = () => loadWorkersProjectWith({ tomlOnly: false });

/**
 * The project as the `[workers.<name>]` entry writer needs to see it: TOML
 * only.
 *
 * `commitWorkerEntry` is a TOML text editor; without `tomlOnly` a JSON
 * project's `configPath` would resolve to `config.json`, and appending a
 * `[workers.<name>]` table there would make the file unparseable.
 */
export const loadWorkersProjectForEntryWrite = () => loadWorkersProjectWith({ tomlOnly: true });

/**
 * As {@link loadWorkersProject}, but never failing on the project config.
 *
 * `status` and `delete` act on the remote worker and consult the project only
 * for the optional source detail; making config loading a prerequisite would
 * strand a deployed worker behind an unrelated local parse error. A config
 * that fails to load degrades to "no `[workers.*]` entries", same shape as
 * {@link describeWorkerForReporting} for the source path.
 */
export const loadWorkersProjectForReporting = Effect.fnUntraced(function* () {
  const loaded = yield* loadWorkersProject().pipe(Effect.option);
  if (Option.isSome(loaded)) {
    return loaded.value;
  }

  const settings = yield* CommandSettings;
  const projectRoot = settings.workdir;
  const supabaseDir = join(projectRoot, "supabase");
  return {
    projectRoot,
    supabaseDir,
    configPath: join(supabaseDir, "config.toml"),
    section: readWorkersSection(undefined),
    workersDir: workersDir(projectRoot),
  } satisfies WorkersProject;
});

interface ResolvedWorker {
  readonly name: string;
  readonly entry: WorkerEntry | undefined;
  /** The worker's default directory, `supabase/workers/<name>/`. */
  readonly defaultDir: string;
  /** Where its code would live, honouring `[workers.<name>] source`. */
  readonly sourceDir: string;
  /**
   * Whether anything local actually establishes {@link sourceDir}.
   *
   * `sourceDir` is always computable — with no entry it falls back to the
   * default directory — so on its own it can't distinguish local code from a
   * worker deployed out of another checkout.
   */
  readonly sourceExists: boolean;
  /**
   * Whether {@link sourceDir} is the path the project actually names.
   *
   * False only when resolution failed and the default directory stood in for a
   * `source` the entry does name — reporting that fallback as the worker's
   * source states a path the project never mentioned.
   */
  readonly sourceResolved: boolean;
}

/**
 * Effectful because confining `sourceDir` to the project needs the
 * filesystem: `source` comes from a committed `config.toml`, and an
 * in-project directory can symlink outside it.
 */
/**
 * As {@link describeWorker}, but never failing on the source path.
 *
 * `status` and `delete` treat the source as an output detail, not a
 * prerequisite, so a `source` resolving outside the project (e.g. a symlink)
 * degrades instead of blocking them. `push` keeps the strict version since
 * there the source is what gets packaged and uploaded.
 */
export const describeWorkerForReporting = Effect.fnUntraced(function* (
  project: WorkersProject,
  name: string,
) {
  const described = yield* describeWorker(project, name).pipe(Effect.option);
  if (Option.isSome(described)) {
    return described.value;
  }
  // Unusable path reads the same as no local source. `sourceResolved: false`
  // stops callers from printing this default-directory stand-in as the entry's source.
  return {
    name,
    entry: project.section.workers[name],
    defaultDir: workerDir(project.projectRoot, name),
    sourceDir: workerDir(project.projectRoot, name),
    sourceExists: false,
    sourceResolved: false,
  } satisfies ResolvedWorker;
});

export const describeWorker = Effect.fnUntraced(function* (project: WorkersProject, name: string) {
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
    sourceResolved: true,
  } satisfies ResolvedWorker;
});

/** Reject a name that could never be a worker, before acting on it. */
export const validateWorkerName = Effect.fnUntraced(function* (name: string) {
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
export const discoverWorkerNames = Effect.fnUntraced(function* (project: WorkersProject) {
  const fs = yield* FileSystem.FileSystem;

  // Missing workers root reads as "no workers here", since a project can still
  // name workers elsewhere via `source`. Any other read error propagates rather
  // than silently reporting an empty `push` as "deployed everything".
  const entries = yield* fs
    .readDirectory(project.workersDir)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound")
          ? Effect.succeed<ReadonlyArray<string>>([])
          : Effect.fail(error),
      ),
    );

  const scaffolded: Array<string> = [];
  for (const entry of entries) {
    // Only a name that vanished between the listing and this stat is skipped.
    const info = yield* fs.stat(join(project.workersDir, entry)).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound") ? Effect.succeedNone : Effect.fail(error),
      ),
    );
    if (Option.isSome(info) && info.value.type === "Directory") {
      scaffolded.push(entry);
    }
  }

  return [...new Set([...scaffolded, ...Object.keys(project.section.workers)])]
    .filter((name) => validateWorkerNameMessage(name) === undefined)
    .sort();
});
