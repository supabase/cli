import { Effect, Option } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { Stdin } from "../../shared/runtime/stdin.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";

/** Go's non-TTY `Console.ReadLine` timeout (`internal/utils/console.go:36`). */
const LEGACY_NON_TTY_TIMEOUT_MILLIS = 100;

/**
 * Port of Go's `parseYesNo` (`apps/cli-go/internal/utils/console.go:84-93`):
 * case-insensitive and trimmed. `y`/`yes` → `true`, `n`/`no` → `false`,
 * anything else → `undefined` (caller falls back to the default).
 */
export const legacyParseYesNo = (input: string): boolean | undefined => {
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
 * Confirm-or-default prompt mirroring Go's `console.PromptYesNo`
 * (`apps/cli-go/internal/utils/console.go:64-82`), shared by `config push`,
 * `db pull`, `seed buckets`, and `storage rm`:
 *  - when `yes` is set, echoes `<label> [Y/n|y/N] y` and returns true even on a
 *    TTY (Go auto-confirms with the affirmative echo, `console.go:70-72`);
 *  - when `interactive` is false (Go callers that force `console.IsTTY = false`,
 *    e.g. `buckets.Run(ctx, "", false, fsys)` during `db reset`), behaves like a
 *    non-TTY stdin: label + one bounded line scan, honoring a parsed answer;
 *  - `json`/`stream-json` output never prompts and uses the default silently;
 *  - a real TTY otherwise prompts with the given default via clack;
 *  - on a non-TTY stdin, Go does **not** short-circuit to the default: it prints
 *    the label, scans the next piped line, echoes it, and honors a parsed answer
 *    (`console.go:74-82,96-102`). Only empty/unparseable input falls back to the
 *    default. The shared `Stdin` reader supplies the piped line (one per prompt).
 *
 * Callers resolve `yes` via `legacyResolveYes` so it honors both `--yes` and
 * `SUPABASE_YES`, matching Go's `viper.GetBool("YES")` (root.go:318-320,334).
 */
export const legacyPromptYesNo = Effect.fnUntraced(function* (
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
  // `interactive === false` mirrors Go callers that force `console.IsTTY = false`
  // (e.g. `buckets.Run(ctx, "", false, fsys)` during `db reset`): Go does NOT
  // silently take the default — `PromptYesNo` still prints the label, scans one
  // line with the 100ms timeout, echoes it, and honors a parsed answer
  // (`console.go:64-102`). So route it through the same non-TTY read path.
  if (!interactive || !tty.stdinIsTty) {
    // Go's `PromptText` prints the label, then `ReadLine` scans one line and (on a
    // non-TTY) echoes it to stderr (`console.go:96-102`). A parsed piped answer
    // wins; an empty/exhausted scan or an unparseable line uses the default.
    yield* output.raw(`${label} [${choices}] `, "stderr");
    const stdin = yield* Stdin;
    const line = yield* stdin.readLine(LEGACY_NON_TTY_TIMEOUT_MILLIS);
    const input = Option.getOrElse(line, () => "");
    yield* output.raw(`${input}\n`, "stderr");
    if (input.length > 0) {
      const answer = legacyParseYesNo(input);
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
