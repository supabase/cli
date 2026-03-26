import { Effect } from "effect";
import { deleteManagedStackPersistence, stopDaemon } from "@supabase/stack/effect";
import { CliConfig } from "../../config/cli-config.service.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import { Output } from "../../output/output.service.ts";
import { RuntimeInfo } from "../../runtime/runtime-info.service.ts";
import type { StopFlags } from "./stop.command.ts";

export const stop = Effect.fnUntraced(function* (flags: StopFlags) {
  const output = yield* Output;
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const cwd = runtimeInfo.cwd;

  yield* output.intro("Stop local Supabase stack");

  if (flags.noBackup) {
    yield* stopDaemon({
      cwd,
      cacheRoot: cliConfig.supabaseHome,
      projectDir: projectHome.projectRoot,
      projectStateRoot: projectHome.projectHomeDir,
      name: flags.stack,
    }).pipe(Effect.catchTag("NoRunningStackError", () => Effect.void));
    yield* deleteManagedStackPersistence({
      cwd,
      cacheRoot: cliConfig.supabaseHome,
      projectDir: projectHome.projectRoot,
      projectStateRoot: projectHome.projectHomeDir,
      name: flags.stack,
    });

    yield* output.success("Local Supabase stopped and persisted data deleted");
    yield* output.outro("Local Supabase stack stopped and local data deleted.");
    return;
  }

  yield* stopDaemon({
    cwd,
    cacheRoot: cliConfig.supabaseHome,
    projectDir: projectHome.projectRoot,
    projectStateRoot: projectHome.projectHomeDir,
    name: flags.stack,
  });

  yield* output.success("Local Supabase stopped");
  yield* output.outro("Local Supabase stack stopped.");
});
