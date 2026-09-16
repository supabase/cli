import { Effect, Option } from "effect";

import { Output } from "../shared/output/output.service.ts";
import { Stdin } from "../shared/runtime/stdin.service.ts";
import { Tty } from "../shared/runtime/tty.service.ts";

const NON_TTY_TIMEOUT_MILLIS = 100;

/**
 * Parses a yes/no answer, case-insensitively and trimmed: `y`/`yes` → `true`, `n`/`no` →
 * `false`, anything else → `undefined` (caller falls back to the default).
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
 * `yes` echoes an affirmative answer and returns `true` immediately; non-text output uses
 * the default silently; a real interactive TTY prompts via clack; otherwise (including
 * `interactive: false`) it reads one line via the shared `Stdin` reader, falling back to
 * the default only when the line is empty or unparseable.
 */
export const promptYesNo = Effect.fnUntraced(function* (
  output: typeof Output.Service,
  yes: boolean,
  label: string,
  defaultValue: boolean,
  interactive = true,
) {
  const choices = defaultValue ? "Y/n" : "y/N";
  if (yes) {
    yield* output.raw(`${label} [${choices}] y\n`, "stderr");
    return true;
  }
  if (output.format !== "text") {
    return defaultValue;
  }
  const tty = yield* Tty;
  // `interactive: false` still prints the label and reads one line instead of silently
  // returning the default — it uses the same non-TTY read path below.
  if (!interactive || !tty.stdinIsTty) {
    // A parsed piped answer wins; an empty or unparseable line falls back to the default.
    yield* output.raw(`${label} [${choices}] `, "stderr");
    const stdin = yield* Stdin;
    const line = yield* stdin.readLine(NON_TTY_TIMEOUT_MILLIS);
    const input = Option.getOrElse(line, () => "");
    yield* output.raw(`${input}\n`, "stderr");
    if (input.length > 0) {
      const answer = parseYesNo(input);
      if (answer !== undefined) {
        return answer;
      }
    }
    return defaultValue;
  }
  return yield* output
    .promptConfirm(label, { defaultValue })
    .pipe(Effect.catchTag("NonInteractiveError", () => Effect.succeed(defaultValue)));
});
