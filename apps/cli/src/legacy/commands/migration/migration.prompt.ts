import { Effect, Option } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";

/** Go's `parseYesNo` (`internal/utils/console.go:84-93`): case-insensitive y/yes/n/no. */
const parseYesNo = (value: string): boolean | undefined => {
  const lower = value.toLowerCase();
  if (lower === "y" || lower === "yes") return true;
  if (lower === "n" || lower === "no") return false;
  return undefined;
};

/**
 * Port of Go's `utils.NewConsole().PromptYesNo(ctx, label, def)`
 * (`internal/utils/console.go`), shared by the prompting migration subcommands
 * (fetch / repair / down / squash):
 *
 *  - `--yes` always returns `true` and echoes `<title> [Y/n|y/N] y` to stderr,
 *    matching Go's `viper.GetBool("YES")` branch (checked before reading stdin).
 *  - Otherwise Go ALWAYS prints the label and reads one line of stdin; `IsTTY` only
 *    changes the read timeout, it does NOT gate whether stdin is read
 *    (`console.go:38-61,96-107`). On a TTY we use the interactive confirm; without a
 *    TTY we read the piped answer, echo it (Go echoes non-TTY input, `console.go:104`),
 *    and parse it. An empty / unparseable answer falls back to `def`.
 *
 * Note: Go bounds the non-TTY read with a 100 ms timeout (`console.go:36`) so an
 * open-but-silent stdin can't hang. We read to EOF instead (piped/CI stdin closes),
 * which honors piped answers; reproducing the exact timed read is a separate refinement.
 */
export const legacyMigrationConfirm = (
  title: string,
  options: { readonly defaultValue: boolean; readonly yes: boolean },
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const choices = options.defaultValue ? "Y/n" : "y/N";
    if (options.yes) {
      yield* output.raw(`${title} [${choices}] y\n`, "stderr");
      return true;
    }

    const tty = yield* Tty;
    if (tty.stdinIsTty) {
      return yield* output
        .promptConfirm(title, { defaultValue: options.defaultValue })
        .pipe(Effect.orElseSucceed(() => options.defaultValue));
    }

    // Non-TTY: Go still prints the label (`fmt.Fprint(os.Stderr, label)`) and reads
    // stdin, so a piped `y`/`n` answer is honored. Take the first line (Go reads one
    // line via `bufio.Scanner`), echo it like Go's non-TTY branch, then parse.
    const stdin = yield* Stdin;
    yield* output.raw(`${title} [${choices}] `, "stderr");
    const input = Option.getOrElse(yield* stdin.readPipedText, () => "")
      .split(/\r?\n/u)[0]!
      .trim();
    yield* output.raw(`${input}\n`, "stderr");
    return parseYesNo(input) ?? options.defaultValue;
  });
