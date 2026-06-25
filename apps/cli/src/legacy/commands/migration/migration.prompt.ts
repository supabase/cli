import { Effect } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";

/**
 * Port of Go's `utils.NewConsole().PromptYesNo(ctx, label, def)`
 * (`internal/utils/console.go`), shared by the prompting migration subcommands
 * (fetch / repair / down / squash):
 *
 *  - `--yes` always returns `true` and echoes `<title> [Y/n|y/N] y` to stderr,
 *    matching Go's `viper.GetBool("YES")` branch (checked before reading stdin).
 *  - Go gates the prompt on stdin being a terminal (`ReadLine` → `term.IsTerminal`,
 *    `console.go:27`), NOT on output format — a non-TTY run returns `def` without
 *    prompting regardless of `--output-format`. (In json/stream-json the prompt
 *    layer is non-interactive, so `promptConfirm` also falls back to `def`.)
 *  - Otherwise prompt; any prompt error (non-interactive / timeout) falls back to
 *    `def`, matching Go's `return def, err`.
 */
export const legacyMigrationConfirm = (
  title: string,
  options: { readonly defaultValue: boolean; readonly yes: boolean },
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const tty = yield* Tty;
    const choices = options.defaultValue ? "Y/n" : "y/N";
    if (options.yes) {
      yield* output.raw(`${title} [${choices}] y\n`, "stderr");
      return true;
    }
    if (!tty.stdinIsTty) return options.defaultValue;
    return yield* output
      .promptConfirm(title, { defaultValue: options.defaultValue })
      .pipe(Effect.orElseSucceed(() => options.defaultValue));
  });
