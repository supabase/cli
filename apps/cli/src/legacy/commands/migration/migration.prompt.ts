import { Effect, Option } from "effect";

import { legacyParseYesNo } from "../../../shared/legacy/legacy-prompt-yes-no.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";

/** The established console read-line timeouts. */
const TTY_TIMEOUT_MILLIS = 10 * 60 * 1000;
const NON_TTY_TIMEOUT_MILLIS = 100;

/**
 * The console yes/no prompt shared by the prompting migration subcommands
 * (fetch / repair / down / squash).
 *
 * This deliberately diverges from the general `legacyPromptYesNo`
 * (`shared/legacy/legacy-prompt-yes-no.ts`) on two axes — do NOT "unify" them
 * without deciding both behaviors (CLI-1974 review):
 *  - json/stream-json: the label is written to STDERR and one line of STDIN is
 *    read regardless of the `--output` format (which only shapes stdout), so this prompts
 *    independently of `output.format` and does NOT route through `output.promptConfirm`
 *    — the json/stream-json Output layers make that non-interactive, which would
 *    silently auto-default a real TTY run under `--output-format json` (fetch
 *    auto-overwriting, down/repair-all auto-cancelling). `legacyPromptYesNo` instead
 *    silently takes the default in machine modes.
 *  - real TTY: this reads a raw stdin line with a 10-minute timeout;
 *    `legacyPromptYesNo` renders a clack confirm UI.
 *
 * `--yes` short-circuits to `true`, echoing `<label> y`.
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

    // Print the label to stderr, read one line of stdin (TTY 10 min /
    // non-TTY 100 ms). A non-TTY run echoes the input back to stderr; a
    // TTY echoes via the terminal. An empty / unparseable answer falls back to the default.
    yield* output.raw(label, "stderr");
    const line = yield* stdin.readLine(stdin.isTTY ? TTY_TIMEOUT_MILLIS : NON_TTY_TIMEOUT_MILLIS);
    const input = Option.getOrElse(line, () => "");
    if (!stdin.isTTY) yield* output.raw(`${input}\n`, "stderr");
    return legacyParseYesNo(input) ?? options.defaultValue;
  });
