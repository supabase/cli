import { Effect, Option, Path } from "effect";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { initProject } from "../../shared/init/project-init.ts";
import { Output } from "../../shared/output/output.service.ts";
import { ExperimentalFlag, WorkdirFlag, resolveYes } from "../../command-internal/global-flags.ts";
import { InitConfigExistsError, InitExperimentalRequiredError } from "./init.errors.ts";
import type { InitFlags } from "./init.command.ts";

export const init = Effect.fn("init")(function* (flags: InitFlags) {
  const output = yield* Output;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const experimental = yield* ExperimentalFlag;
  const workdir = yield* WorkdirFlag;

  if (flags.useOrioledb && !experimental) {
    return yield* new InitExperimentalRequiredError({
      message: `required flag(s) "experimental" not set`,
    });
  }

  const result = yield* initProject({
    cwd: Option.isSome(workdir) ? path.resolve(runtimeInfo.cwd, workdir.value) : runtimeInfo.cwd,
    force: flags.force,
    useOrioledb: flags.useOrioledb,
    interactive: flags.interactive,
    // `--yes`/`SUPABASE_YES` auto-accepts the `-i` IDE prompts with the established stderr
    // echo instead of prompting.
    yes: yield* resolveYes,
    withVscodeSettings: flags.withVscodeWorkspace || flags.withVscodeSettings,
    withIntellijSettings: flags.withIntellijSettings,
  });

  if (!result.created) {
    // The path in this message is always the relative `supabase/config.toml`, regardless of
    // cwd or `--workdir`. Windows uses a backslash and "The file exists."; POSIX uses a
    // forward slash and "file exists".
    const message =
      runtimeInfo.platform === "win32"
        ? "failed to create config file: open supabase\\config.toml: The file exists."
        : "failed to create config file: open supabase/config.toml: file exists";
    return yield* new InitConfigExistsError({
      message,
      suggestion: "Run supabase init --force to overwrite existing config file.",
    });
  }

  yield* output.raw("Finished supabase init.\n");
});
