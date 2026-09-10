import { findCliProjectPaths, loadCliConfig } from "@supabase/config/effect";
import { Effect, FileSystem, Option, Path, Predicate } from "effect";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { shouldSearchAncestors } from "../../../command-internal/workdir-search.ts";
import {
  readComputeSection,
  type ComputeEntry,
  type ComputeSection,
} from "../../../shared/compute/compute-config.ts";
import {
  computeDir,
  computeRootDir,
  computeSourceDir,
} from "../../../shared/compute/compute-paths.ts";
import { validateComputeNameMessage } from "../../../shared/compute/compute-runtimes.ts";
import { InvalidComputeNameError } from "../../../shared/compute/compute.errors.ts";

/**
 * What every `supabase compute` command needs before it does anything: where
 * the project is, what `[compute]` says, and which compute is being acted on.
 *
 * The project directory is `CommandSettings.workdir` rather than an ancestor
 * walk from the current directory. That is the resolved workdir every other
 * command acts on — `--workdir`/`SUPABASE_WORKDIR` when given, else the
 * ancestor walk Go's own `getProjectRoot` performs — so `supabase compute`
 * answers to the same flag as its siblings instead of inventing a second notion
 * of "which project".
 */

export interface ComputeProject {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly configPath: string;
  readonly section: ComputeSection;
  /** `supabase/compute/`, where every compute lives unless it names a `source`. */
  readonly computeDir: string;
}

const loadComputeProjectWith = Effect.fnUntraced(function* (options: {
  readonly tomlOnly: boolean;
}) {
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;

  // tomlOnly (the [compute.*] entry writer) keeps `search: false` unconditionally:
  // it and the workdir's own default resolution probe the same config.toml, so the
  // second climb is redundant. The JSON-capable read must thread the predicate — the
  // default workdir resolution only probes config.toml, so a config.json-only project
  // invoked from a subdirectory relies on this climb to be found at all (CLI-2285).
  //
  // `compute new api --workdir ./bare-dir` inside another project is why
  // `projectRoot` must be DERIVED from this same search rather than always
  // `settings.workdir`: with an explicit workdir the predicate yields `false`
  // (see `shouldSearchAncestors`), so `paths` is null and `projectRoot`
  // falls back to `settings.workdir` exactly as before — that scaffold-into-a-
  // bare-directory behavior is preserved verbatim. Only a DEFAULTED workdir can
  // ever climb here, and when it does, `projectRoot` must climb WITH `configPath`
  // — otherwise a discovered ancestor's `[compute.*]` entries would resolve their
  // `source` against a non-project directory.
  const search = options.tomlOnly ? false : shouldSearchAncestors(settings);
  const paths = yield* findCliProjectPaths(settings.workdir, { search });
  const projectRoot = paths?.projectRoot ?? settings.workdir;
  const supabaseDir = path.join(projectRoot, "supabase");

  // `search: false`: the climb (if any) already happened above; reading
  // `projectRoot`'s own config.toml again must never climb a second time.
  const loaded = yield* loadCliConfig(projectRoot, { tomlOnly: options.tomlOnly, search: false });
  const section = readComputeSection(loaded?.config.compute);

  return {
    projectRoot,
    supabaseDir,
    configPath: loaded?.path ?? path.join(supabaseDir, "config.toml"),
    section,
    computeDir: computeRootDir(path, projectRoot),
  } satisfies ComputeProject;
});

/**
 * The project as a reader sees it, following the loader's normal
 * JSON-over-TOML selection. `config.json` is a supported project format, so a
 * command that only reads `[compute.*]` has to honour it — otherwise a JSON
 * project deploys with a guessed runtime and default size and instance counts
 * instead of the ones it configured, and a compute whose `source` sits outside
 * `supabase/compute/` is not discovered at all.
 */
export const loadComputeProject = loadComputeProjectWith({ tomlOnly: false });

/**
 * The project as the `[compute.<name>]` entry writer needs to see it: TOML
 * only.
 *
 * `commitComputeEntry` is a TOML text editor. Without `tomlOnly` the loader
 * prefers `supabase/config.json` when one exists, `configPath` becomes the JSON
 * file, and the writer appends a `[compute.<name>]` table to it — leaving the
 * project config unparseable after the scaffold is already on disk.
 * `functions new` avoids the same trap by resolving `supabase/config.toml`
 * directly; this is that, through the loader.
 *
 * A JSON project therefore gets a `config.toml` written beside its
 * `config.json`, which the loader lists in `ignoredPaths`. That gap is the
 * writer's alone — reads go through {@link loadComputeProject} — and it
 * closes when config writing is overhauled.
 */
export const loadComputeProjectForEntryWrite = loadComputeProjectWith({ tomlOnly: true });

/**
 * As {@link loadComputeProject}, but never failing on the project config.
 *
 * For commands that only *report* on local state — `status` and `delete` —
 * which act on the remote compute and consult the project purely to add the
 * optional source detail. Making it a prerequisite stranded a deployed compute
 * behind an unrelated local parse error, even when `--project-ref` named the
 * project explicitly and nothing local was going to be touched.
 *
 * A config that will not load reads the same as a project with no
 * `[compute.*]` entries: no entry, no configured source, so no source row.
 * Same degrade-rather-than-fail shape as
 * {@link describeComputeForReporting}, which does it for the source path.
 */
export const loadComputeProjectForReporting = Effect.fnUntraced(function* () {
  const loaded = yield* loadComputeProject.pipe(Effect.option);
  if (Option.isSome(loaded)) {
    return loaded.value;
  }

  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  const projectRoot = settings.workdir;
  const supabaseDir = path.join(projectRoot, "supabase");
  return {
    projectRoot,
    supabaseDir,
    configPath: path.join(supabaseDir, "config.toml"),
    section: readComputeSection(undefined),
    computeDir: computeRootDir(path, projectRoot),
  } satisfies ComputeProject;
});

interface ResolvedCompute {
  readonly name: string;
  readonly entry: ComputeEntry | undefined;
  /** The compute's default directory, `supabase/compute/<name>/`. */
  readonly defaultDir: string;
  /** Where its code would live, honouring `[compute.<name>] source`. */
  readonly sourceDir: string;
  /**
   * Whether anything local actually establishes {@link sourceDir}.
   *
   * `sourceDir` is always computable — with no entry it falls back to the default
   * directory — so it cannot on its own tell a compute whose code is on this
   * machine from one deployed out of another checkout. Commands that print local
   * paths need that difference before they state one as fact.
   */
  readonly sourceExists: boolean;
  /**
   * Whether {@link sourceDir} is the path the project actually names.
   *
   * False only when resolution failed and the default directory stood in for a
   * `source` the entry does name — reporting that fallback as the compute's
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
 * As {@link describeCompute}, but never failing on the source path.
 *
 * For commands that only *report* on local state — `status` and `delete` — where
 * the source is a detail of the output, not a prerequisite. Making confinement
 * mandatory there stranded the remote compute: a `source` that resolves outside
 * the project (an in-project directory that became a symlink, say) failed the
 * describe before either API call, so `delete` could not remove a compute whose
 * local files it was never going to touch.
 *
 * `push` keeps the strict version, because there the source *is* what gets
 * packaged and uploaded.
 */
export const describeComputeForReporting = Effect.fnUntraced(function* (
  project: ComputeProject,
  name: string,
) {
  const path = yield* Path.Path;
  const described = yield* describeCompute(project, name).pipe(Effect.option);
  if (Option.isSome(described)) {
    return described.value;
  }
  // The path is unusable, which for reporting purposes reads the same as having
  // nothing local at all. `sourceResolved: false` keeps callers from printing
  // this stand-in as the source the entry names — it is the default directory,
  // not the path that failed.
  return {
    name,
    entry: project.section.compute[name],
    defaultDir: computeDir(path, project.projectRoot, name),
    sourceDir: computeDir(path, project.projectRoot, name),
    sourceExists: false,
    sourceResolved: false,
  } satisfies ResolvedCompute;
});

export const describeCompute = Effect.fnUntraced(function* (project: ComputeProject, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = project.section.compute[name];
  const defaultDir = computeDir(path, project.projectRoot, name);
  const sourceDir = yield* computeSourceDir({
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
  } satisfies ResolvedCompute;
});

/** Reject a name that could never be a compute, before acting on it. */
export const validateComputeName = Effect.fnUntraced(function* (name: string) {
  const invalid = validateComputeNameMessage(name);
  if (invalid !== undefined) {
    return yield* new InvalidComputeNameError({
      detail: `"${name}" is not a valid compute name. ${invalid}`,
      suggestion: "Compute names become hostnames, so they must be DNS labels.",
    });
  }
  return name;
});

/**
 * Every compute in the project, for a command given no names: the directories
 * under the compute root, unioned with the `[compute.<name>]` entries, since a
 * compute with a `source` lives outside that root and would otherwise be missed.
 *
 * Sorted, so a bare `push` deploys in a stable order rather than whatever the
 * filesystem happened to return.
 */
export const discoverComputeNames = Effect.fnUntraced(function* (project: ComputeProject) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // No compute root at all is a project that has never scaffolded one, and the
  // config entries below may still name compute living elsewhere — so absence
  // reads as nothing here. Any other reason propagates: a root the CLI cannot
  // list is not a project with no compute in it, and answering a bare `push`
  // with "deployed everything" after silently skipping them is the worst
  // possible reading of it.
  const entries = yield* fs
    .readDirectory(project.computeDir)
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
    const info = yield* fs.stat(path.join(project.computeDir, entry)).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound") ? Effect.succeedNone : Effect.fail(error),
      ),
    );
    if (Option.isSome(info) && info.value.type === "Directory") {
      scaffolded.push(entry);
    }
  }

  return [...new Set([...scaffolded, ...Object.keys(project.section.compute)])]
    .filter((name) => validateComputeNameMessage(name) === undefined)
    .sort();
});
