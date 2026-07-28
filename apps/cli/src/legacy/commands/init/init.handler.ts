import { resolve } from "node:path";
import { Effect, Option } from "effect";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { initProject } from "../../../shared/init/project-init.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  LegacyExperimentalFlag,
  LegacyWorkdirFlag,
  legacyResolveYes,
} from "../../../shared/legacy/global-flags.ts";
import { LegacyInitConfigExistsError, LegacyInitExperimentalRequiredError } from "./init.errors.ts";
import type { LegacyInitFlags } from "./init.command.ts";

export const legacyInit = Effect.fn("legacy.init")(function* (flags: LegacyInitFlags) {
  const output = yield* Output;
  const runtimeInfo = yield* RuntimeInfo;
  const experimental = yield* LegacyExperimentalFlag;
  const workdir = yield* LegacyWorkdirFlag;

  if (flags.useOrioledb && !experimental) {
    // Go marks `experimental` required in PreRun (`cmd/init.go:32-36`), so cobra's
    // `ValidateRequiredFlags` fails with its standard required-flag message.
    return yield* Effect.fail(
      new LegacyInitExperimentalRequiredError({
        message: `required flag(s) "experimental" not set`,
      }),
    );
  }

  const result = yield* initProject({
    cwd: Option.isSome(workdir) ? resolve(runtimeInfo.cwd, workdir.value) : runtimeInfo.cwd,
    force: flags.force,
    useOrioledb: flags.useOrioledb,
    interactive: flags.interactive,
    // `--yes` OR `SUPABASE_YES` (Go's `viper.GetBool("YES")`, root.go:318-320):
    // auto-accepts the `-i` IDE prompts with Go's stderr echo instead of
    // prompting anyway (CLI-1974).
    yes: yield* legacyResolveYes,
    withVscodeSettings: flags.withVscodeWorkspace || flags.withVscodeSettings,
    withIntellijSettings: flags.withIntellijSettings,
  });

  if (!result.created) {
    // Go's message embeds the `*os.PathError` from the `O_EXCL` open of
    // `utils.ConfigPath`, which is *relative* — so the path in the message is
    // always `supabase/config.toml` regardless of cwd or `--workdir`. The full
    // literal is the byte-exact Go output on Linux/macOS (POSIX EEXIST text);
    // Windows Go prints its own separator and OS errno text and is deliberately
    // out of scope for this parity fix.
    return yield* Effect.fail(
      new LegacyInitConfigExistsError({
        message: "failed to create config file: open supabase/config.toml: file exists",
        suggestion: "Run supabase init --force to overwrite existing config file.",
      }),
    );
  }

  yield* output.raw("Finished supabase init.\n");
});
