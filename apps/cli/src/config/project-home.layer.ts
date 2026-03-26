import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { ProjectContext } from "./project-context.service.ts";
import { ProjectHome } from "./project-home.service.ts";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";

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
      if (yield* fs.exists(projectLinkPath).pipe(Effect.orDie)) {
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

  const ensureProjectHomeDir = Effect.gen(function* () {
    yield* fs.makeDirectory(projectHomeDir, { recursive: true, mode: 0o700 });
  }).pipe(Effect.orDie);

  const stackDir = (name: string) => path.join(projectHomeDir, "stacks", name);

  return ProjectHome.of({
    projectRoot,
    supabaseDir,
    projectHomeDir,
    projectLinkPath,
    projectLocalVersionsPath,
    ensureProjectHomeDir,
    stackDir,
    stackStatePath: (name: string) => path.join(stackDir(name), "state.json"),
    stackMetadataPath: (name: string) => path.join(stackDir(name), "stack.json"),
    stackDataDir: (name: string) => path.join(stackDir(name), "data"),
    stackLogsDir: (name: string) => path.join(stackDir(name), "logs"),
  });
});

export const projectHomeLayer = Layer.effect(ProjectHome, makeProjectHome);
