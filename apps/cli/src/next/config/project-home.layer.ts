import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { ProjectContext } from "./project-context.service.ts";
import { ProjectHome, ProjectHomeNotDirectoryError } from "./project-home.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";

const PROJECT_HOME_DIR_NAME = ".supabase";
const PROJECT_LINK_FILE_NAME = "project.json";

const findProjectRootFromRepoState = (
  cwd: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const start = path.resolve(cwd);
    let current = start;
    const root = path.parse(current).root;

    while (true) {
      const projectLinkPath = path.join(current, PROJECT_HOME_DIR_NAME, PROJECT_LINK_FILE_NAME);
      // A FILE named `.supabase` along the ancestor walk reads as "no link
      // here" rather than crashing the boot (fs.exists only maps NotFound).
      if (yield* fs.exists(projectLinkPath).pipe(Effect.orElseSucceed(() => false))) {
        return current;
      }
      if (current === root) {
        return start;
      }
      current = path.dirname(current);
    }
  });

const makeProjectHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const projectContext = yield* ProjectContext;

  const projectRoot = Option.isSome(projectContext.paths)
    ? projectContext.paths.value.projectRoot
    : yield* findProjectRootFromRepoState(runtimeInfo.cwd);
  const supabaseDir = path.join(projectRoot, "supabase");
  const projectHomeDir = path.join(projectRoot, PROJECT_HOME_DIR_NAME);
  const projectLinkPath = path.join(projectHomeDir, "project.json");
  const projectLocalVersionsPath = path.join(projectHomeDir, "local-versions.json");

  const ensureProjectHomeDir = fs
    .makeDirectory(projectHomeDir, { recursive: true, mode: 0o700 })
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "AlreadyExists" || error.reason._tag === "BadResource"
          ? Effect.die(
              new ProjectHomeNotDirectoryError({
                message: `${projectHomeDir} could not be created: a file (or a symlink loop) exists at that path or on one of its parent directories. Remove or rename it so the Supabase CLI can store project state there.`,
              }),
            )
          : Effect.die(error),
      ),
    );

  return ProjectHome.of({
    projectRoot,
    supabaseDir,
    projectHomeDir,
    projectLinkPath,
    projectLocalVersionsPath,
    ensureProjectHomeDir,
  });
});

export const projectHomeLayer = Layer.effect(ProjectHome, makeProjectHome);
