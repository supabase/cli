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
 * What every `supabase experimental workers` command needs before it does anything: where
 * the project is, what `[workers]` says, and which worker is being acted on.
 *
 * The project directory is `CommandSettings.workdir` rather than an ancestor
 * walk from the current directory. That is the resolved workdir every other
 * command acts on — `--workdir`/`SUPABASE_WORKDIR` when given, else the
 * ancestor walk Go's own `getProjectRoot` performs — so `supabase experimental workers`
 * answers to the same flag as its siblings instead of inventing a second notion
 * of "which project".
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

  // tomlOnly (the [workers.*] entry writer) keeps `search: false` unconditionally:
  // it and the workdir's own default resolution probe the same config.toml, so the
  // second climb is redundant. The JSON-capable read must thread the predicate — the
  // default workdir resolution only probes config.toml, so a config.json-only project
  // invoked from a subdirectory relies on this climb to be found at all (CLI-2285).
  //
  // `workers new api --workdir ./bare-dir` inside another project is why
  // `projectRoot` must be DERIVED from this same search rather than always
  // `settings.workdir`: with an explicit workdir the predicate yields `false`
  // (see `shouldSearchAncestors`), so `paths` is null and `projectRoot`
  // falls back to `settings.workdir` exactly as before — that scaffold-into-a-
  // bare-directory behavior is preserved verbatim. Only a DEFAULTED workdir can
  // ever climb here, and when it does, `projectRoot` must climb WITH `configPath`
  // — otherwise a discovered ancestor's `[workers.*]` entries would resolve their
  // `source` against a non-project directory.
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
 * JSON-over-TOML selection. `config.json` is a supported project format, so a
 * command that only reads `[workers.*]` has to honour it — otherwise a JSON
 * project deploys with a guessed runtime and default size and instance counts
 * instead of the ones it configured, and a worker whose `source` sits outside
 * `supabase/workers/` is not discovered at all.
 */
export const loadWorkersProject = () => loadWorkersProjectWith({ tomlOnly: false });

/**
 * The project as the `[workers.<name>]` entry writer needs to see it: TOML
 * only.
 *
 * `commitWorkerEntry` is a TOML text editor. Without `tomlOnly` the loader
 * prefers `supabase/config.json` when one exists, `configPath` becomes the JSON
 * file, and the writer appends a `[workers.<name>]` table to it — leaving the
 * project config unparseable after the scaffold is already on disk.
 * `functions new` avoids the same trap by resolving `supabase/config.toml`
 * directly; this is that, through the loader.
 *
 * A JSON project therefore gets a `config.toml` written beside its
 * `config.json`, which the loader lists in `ignoredPaths`. That gap is the
 * writer's alone — reads go through {@link loadWorkersProject} — and it
 * closes when config writing is overhauled.
 */
export const loadWorkersProjectForEntryWrite = () => loadWorkersProjectWith({ tomlOnly: true });

/**
 * As {@link loadWorkersProject}, but never failing on the project config.
 *
 * For commands that only *report* on local state — `status` and `delete` —
 * which act on the remote worker and consult the project purely to add the
 * optional source detail. Making it a prerequisite stranded a deployed worker
 * behind an unrelated local parse error, even when `--project-ref` named the
 * project explicitly and nothing local was going to be touched.
 *
 * A config that will not load reads the same as a project with no
 * `[workers.*]` entries: no entry, no configured source, so no source row.
 * Same degrade-rather-than-fail shape as
 * {@link describeWorkerForReporting}, which does it for the source path.
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

export interface ResolvedWorker {
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
 * Effectful because resolving `sourceDir` confines it to the project, and that
 * verdict needs the filesystem: `source` comes from a committed `config.toml`,
 * and a directory inside the project can symlink anywhere outside it.
 */
/**
 * As {@link describeWorker}, but never failing on the source path.
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
export const describeWorkerForReporting = Effect.fnUntraced(function* (
  project: WorkersProject,
  name: string,
) {
  const described = yield* describeWorker(project, name).pipe(Effect.option);
  if (Option.isSome(described)) {
    return described.value;
  }
  // The path is unusable, which for reporting purposes reads the same as having
  // nothing local at all. `sourceResolved: false` keeps callers from printing
  // this stand-in as the source the entry names — it is the default directory,
  // not the path that failed.
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

  // No workers root at all is a project that has never scaffolded one, and the
  // config entries below may still name workers living elsewhere — so absence
  // reads as nothing here. Any other reason propagates: a root the CLI cannot
  // list is not a project with no workers in it, and answering a bare `push`
  // with "deployed everything" after silently skipping them is the worst
  // possible reading of it.
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
