import { Effect, Option } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";

/** Go's `Console.ReadLine` timeouts (`internal/utils/console.go:35-36`). */
const TTY_TIMEOUT_MILLIS = 10 * 60 * 1000;
const NON_TTY_TIMEOUT_MILLIS = 100;

/** Go's `parseYesNo` (`internal/utils/console.go:84-93`): case-insensitive y/yes/n/no. */
const parseYesNo = (value: string): boolean | undefined => {
  const lower = value.toLowerCase();
  if (lower === "y" || lower === "yes") return true;
  if (lower === "n" || lower === "no") return false;
  return undefined;
};

/**
 * Port of Go's `utils.NewConsole().PromptYesNo(ctx, label, def)`
 * (`internal/utils/console.go:64-107`), shared by the prompting migration subcommands
 * (fetch / repair / down / squash).
 *
 * Go writes the label to STDERR and reads one line of STDIN regardless of the `--output`
 * format (which only shapes stdout); `IsTTY` changes only the read timeout (10 min vs
 * 100 ms) and whether the input is echoed. So this prompts independently of
 * `output.format` and does NOT route through `output.promptConfirm` — the json/stream-json
 * Output layers make that non-interactive, which would silently auto-default a real TTY run
 * under `--output-format json` (fetch auto-overwriting, down/repair-all auto-cancelling).
 * `--yes` short-circuits to `true`, echoing `<label> y` like Go's `viper.GetBool("YES")`.
 */
export const legacyMigrationConfirm = (
  title: string,
  options: { readonly defaultValue: boolean; readonly yes: boolean },
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const stdin = yield* Stdin;
    const choices = options.defaultValue ? "Y/n" : "y/N";
    const label = `${title} [${choices}] `;
    if (options.yes) {
      yield* output.raw(`${label}y\n`, "stderr");
      return true;
    }

    // Go's `PromptText`: print the label to stderr, read one line of stdin (TTY 10 min /
    // non-TTY 100 ms). A non-TTY run echoes the input back to stderr (`console.go:104`); a
    // TTY echoes via the terminal. An empty / unparseable answer falls back to the default.
    yield* output.raw(label, "stderr");
    const line = yield* stdin.readLine(stdin.isTTY ? TTY_TIMEOUT_MILLIS : NON_TTY_TIMEOUT_MILLIS);
    const input = Option.getOrElse(line, () => "");
    if (!stdin.isTTY) yield* output.raw(`${input}\n`, "stderr");
    return parseYesNo(input) ?? options.defaultValue;
  });
