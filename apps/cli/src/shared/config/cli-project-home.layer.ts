import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { CliProjectContext } from "./cli-project-context.service.ts";
import { CliProjectHome, CliProjectHomeNotDirectoryError } from "./cli-project-home.service.ts";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";

const PROJECT_HOME_DIR_NAME = ".supabase";
const PROJECT_LINK_FILE_NAME = "project.json";

const findCliProjectRootFromRepoState = (
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

const makeCliProjectHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const cliProjectContext = yield* CliProjectContext;

  const projectRoot = Option.isSome(cliProjectContext.paths)
    ? cliProjectContext.paths.value.projectRoot
    : yield* findCliProjectRootFromRepoState(runtimeInfo.cwd);
  const supabaseDir = path.join(projectRoot, "supabase");
  const projectHomeDir = path.join(projectRoot, PROJECT_HOME_DIR_NAME);
  const projectLinkPath = path.join(projectHomeDir, "project.json");
  const projectLocalVersionsPath = path.join(projectHomeDir, "local-versions.json");

  const ensureCliProjectHomeDir = fs
    .makeDirectory(projectHomeDir, { recursive: true, mode: 0o700 })
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "AlreadyExists" || error.reason._tag === "BadResource"
          ? Effect.die(
              new CliProjectHomeNotDirectoryError({
                message: `${projectHomeDir} could not be created: a file (or a symlink loop) exists at that path or on one of its parent directories. Remove or rename it so the Supabase CLI can store project state there.`,
              }),
            )
          : Effect.die(error),
      ),
    );

  return CliProjectHome.of({
    projectRoot,
    supabaseDir,
    projectHomeDir,
    projectLinkPath,
    projectLocalVersionsPath,
    ensureCliProjectHomeDir,
  });
});

export const cliProjectHomeLayer = Layer.effect(CliProjectHome, makeCliProjectHome);
