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
import {
  ComputeJsonConfigUnsupportedError,
  InvalidComputeNameError,
} from "../../../shared/compute/compute.errors.ts";

/**
 * What every `supabase compute` command needs before it does
 * anything: where the project is, what `[compute]` says, and which compute is
 * being acted on.
 *
 * The project directory is `CommandSettings.workdir`, the same resolved
 * workdir every other command acts on, so `compute` answers to the same
 * `--workdir`/`SUPABASE_WORKDIR` flag as its siblings.
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

  // `tomlOnly` skips the ancestor search (redundant with the default
  // resolution); the JSON-capable read needs it so a config.json-only project
  // run from a subdirectory is still found. `projectRoot` is derived from the
  // same search, not `settings.workdir`, so a climb takes `configPath` with it
  // — otherwise a discovered ancestor's `[compute.*]` entries would resolve
  // `source` against the wrong directory.
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
 * JSON-over-TOML selection.
 *
 * A command that only reads `[compute.*]` still has to honour `config.json`,
 * or a JSON project deploys with a guessed runtime and default size/instance
 * counts instead of the ones it configured.
 */
export const loadComputeProject = loadComputeProjectWith({ tomlOnly: false });

/**
 * The project as the `[compute.<name>]` entry writer needs to see it: TOML
 * only.
 *
 * `commitComputeEntry` is a TOML text editor; without `tomlOnly` a JSON
 * project's `configPath` would resolve to `config.json`, and appending a
 * `[compute.<name>]` table there would make the file unparseable.
 */
export const loadComputeProjectForEntryWrite = Effect.fnUntraced(function* () {
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  const paths = yield* findCliProjectPaths(settings.workdir, {
    search: shouldSearchAncestors(settings),
  });
  if (paths !== null && path.basename(paths.configPath) === "config.json") {
    return yield* new ComputeJsonConfigUnsupportedError({
      detail: `This project is configured by ${paths.configPath}, which the compute new command cannot edit safely.`,
      suggestion: `Create the source files manually and add the compute entry to ${paths.configPath}, or convert the whole project configuration to TOML before scaffolding it.`,
    });
  }
  return yield* loadComputeProjectWith({ tomlOnly: true });
});

/**
 * As {@link loadComputeProject}, but never failing on the project config.
 *
 * `status` and `delete` act on the remote compute and consult the project only
 * for the optional source detail; making config loading a prerequisite would
 * strand a deployed compute behind an unrelated local parse error. A config
 * that fails to load degrades to "no `[compute.*]` entries", same shape as
 * {@link describeComputeForReporting} for the source path.
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
   * `sourceDir` is always computable — with no entry it falls back to the
   * default directory — so on its own it can't distinguish local code from a
   * compute deployed out of another checkout.
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
 * As {@link describeCompute}, but never failing on the source path.
 *
 * `status` and `delete` treat the source as an output detail, not a
 * prerequisite, so a `source` resolving outside the project (e.g. a symlink)
 * degrades instead of blocking them. `push` keeps the strict version since
 * there the source is what gets packaged and uploaded.
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
  // Unusable path reads the same as no local source. `sourceResolved: false`
  // stops callers from printing this default-directory stand-in as the entry's source.
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

  // Missing compute root reads as "no compute here", since a project can still
  // name compute elsewhere via `source`. Any other read error propagates rather
  // than silently reporting an empty `push` as "deployed everything".
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
