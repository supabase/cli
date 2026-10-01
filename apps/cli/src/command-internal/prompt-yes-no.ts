import { Effect, Option } from "effect";

import { Output } from "../shared/output/output.service.ts";
import { Stdin } from "../shared/runtime/stdin.service.ts";
import { Tty } from "../shared/runtime/tty.service.ts";

const NON_TTY_TIMEOUT_MILLIS = 100;

/**
 * Parses a yes/no answer, case-insensitively and trimmed: `y`/`yes` → `true`, `n`/`no` →
 * `false`, anything else → `undefined`.
 */
export const parseYesNo = (input: string): boolean | undefined => {
  const s = input.trim().toLowerCase();
  if (s === "y" || s === "yes") {
    return true;
  }
  if (s === "n" || s === "no") {
    return false;
  }
  return undefined;
};

/**
 * Confirm-or-default prompt shared by command handlers and shell-agnostic code alike.
 * `yes` echoes an affirmative answer and returns `true` immediately; non-text output
 * uses the default silently unless the caller opts into machine-mode piped answers;
 * a real interactive text TTY prompts via clack; otherwise (including text callers with
 * `interactive: false`) it reads one line via the shared `Stdin` reader: a parsed answer
 * wins and an empty line takes the default. Any other line declines, except under
 * `interactive: false`, where it takes the default.
 */
export const promptYesNo = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  label: string,
  defaultValue: boolean,
  interactive = true,
  options: { readonly readMachineStdin?: boolean } = {},
) {
  const choices = defaultValue ? "Y/n" : "y/N";
  if (yes) {
    yield* output.raw(`${label} [${choices}] y\n`, "stderr");
    return true;
  }
  if (output.format !== "text" && !options.readMachineStdin) {
    return defaultValue;
  }
  const tty = yield* Tty;
  if (output.format !== "text" && (!interactive || tty.stdinIsTty)) {
    return defaultValue;
  }
  // Text `interactive: false` still prints the label and reads one line instead of
  // silently returning the default — it uses the same non-TTY read path below.
  if (!interactive || !tty.stdinIsTty) {
    yield* output.raw(`${label} [${choices}] `, "stderr");
    const stdin = yield* Stdin;
    const line = yield* stdin.readLine(NON_TTY_TIMEOUT_MILLIS);
    const input = Option.getOrElse(line, () => "");
    yield* output.raw(`${input.trim()}\n`, "stderr");
    // An unrecognised answer is never consent; under `interactive: false` the line may be
    // the caller's own script text, so it keeps the default.
    return parseYesNo(input) ?? (interactive && input.length > 0 ? false : defaultValue);
  }
  return yield* output
    .promptConfirm(label, { defaultValue })
    .pipe(Effect.catchTag("NonInteractiveError", () => Effect.succeed(defaultValue)));
});
