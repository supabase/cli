import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { initProject, type ProjectInitOptions } from "../../../shared/init/project-init.ts";
import { InitExperimentalRequiredError } from "../../../shared/init/project-init.errors.ts";

export const init = Effect.fnUntraced(function* (
  flags: Omit<ProjectInitOptions, "cwd" | "withVscodeSettings" | "withIntellijSettings"> & {
    readonly experimental: boolean;
  },
) {
  const output = yield* Output;
  const runtimeInfo = yield* RuntimeInfo;

  if (flags.useOrioledb && !flags.experimental) {
    return yield* Effect.fail(
      new InitExperimentalRequiredError({
        detail: "--use-orioledb is only available when experimental features are enabled.",
        suggestion: "Rerun the command with `supabase init --experimental --use-orioledb`.",
      }),
    );
  }

  yield* initProject({
    cwd: runtimeInfo.cwd,
    ...flags,
    withVscodeSettings: false,
    withIntellijSettings: false,
  });

  yield* output.raw("Finished supabase init.\n");
});
