import { resolve } from "node:path";
import { Effect, Option } from "effect";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { initProject } from "../../../shared/init/project-init.ts";
import {
  InitAlreadyExistsError,
  InitExperimentalRequiredError,
} from "../../../shared/init/project-init.errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LegacyExperimentalFlag, LegacyWorkdirFlag } from "../../../shared/legacy/global-flags.ts";
import type { LegacyInitFlags } from "./init.command.ts";

export const legacyInit = Effect.fn("legacy.init")(function* (flags: LegacyInitFlags) {
  const output = yield* Output;
  const runtimeInfo = yield* RuntimeInfo;
  const experimental = yield* LegacyExperimentalFlag;
  const workdir = yield* LegacyWorkdirFlag;

  if (flags.useOrioledb && !experimental) {
    return yield* Effect.fail(
      new InitExperimentalRequiredError({
        detail: "--use-orioledb is only available when experimental features are enabled.",
        suggestion: "Rerun the command with `--experimental --use-orioledb`.",
      }),
    );
  }

  const result = yield* initProject({
    cwd: Option.isSome(workdir) ? resolve(runtimeInfo.cwd, workdir.value) : runtimeInfo.cwd,
    force: flags.force,
    useOrioledb: flags.useOrioledb,
    interactive: flags.interactive,
    withVscodeSettings: flags.withVscodeWorkspace || flags.withVscodeSettings,
    withIntellijSettings: flags.withIntellijSettings,
  });

  if (!result.created) {
    return yield* Effect.fail(
      new InitAlreadyExistsError({
        detail: `Config already exists at ${result.configPath}.`,
        suggestion: "Run `supabase init --force` to overwrite the existing config.",
      }),
    );
  }

  yield* output.raw("Finished supabase init.\n");
});
