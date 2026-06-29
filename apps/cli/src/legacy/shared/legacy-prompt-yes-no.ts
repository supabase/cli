import { Effect } from "effect";

import { Output } from "../../shared/output/output.service.ts";

/**
 * Confirm-or-default prompt mirroring Go's `console.PromptYesNo`
 * (`apps/cli-go/internal/utils/console.go`), shared by `seed buckets` and
 * `storage rm`:
 *  - when `yes` is set, echoes `<label> [Y/n|y/N] y` and returns true even on a
 *    TTY (Go auto-confirms with the affirmative echo);
 *  - a real TTY in text mode otherwise prompts with the given default;
 *  - everything else (non-interactive, json/stream-json) uses the default
 *    silently.
 *
 * Callers resolve `yes` via `legacyResolveYes` so it honors both `--yes` and
 * `SUPABASE_YES`, matching Go's `viper.GetBool("YES")` (root.go:318-320,334).
 */
export const legacyPromptYesNo = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  label: string,
  defaultValue: boolean,
) {
  if (yes) {
    const choices = defaultValue ? "Y/n" : "y/N";
    yield* output.raw(`${label} [${choices}] y\n`, "stderr");
    return true;
  }
  if (output.format !== "text") {
    return defaultValue;
  }
  return yield* output
    .promptConfirm(label, { defaultValue })
    .pipe(Effect.catchTag("NonInteractiveError", () => Effect.succeed(defaultValue)));
});
