import { Effect, Option } from "effect";

import { parseYesNo } from "../../command-internal/prompt-yes-no.ts";
import { Output } from "../../shared/output/output.service.ts";
import { Stdin } from "../../shared/runtime/stdin.service.ts";

/** The established console read-line timeouts. */
const TTY_TIMEOUT_MILLIS = 10 * 60 * 1000;
const NON_TTY_TIMEOUT_MILLIS = 100;

/**
 * The console yes/no prompt shared by fetch/repair/down/squash. Diverges from the
 * general `promptYesNo`: it writes the label to stderr and reads one stdin line
 * regardless of `--output` format (rather than auto-defaulting in json/stream-json),
 * and on a real TTY it reads a raw stdin line with a 10-minute timeout instead of a
 * clack confirm UI. `--yes` short-circuits to `true`, echoing `<label> y`.
 */
export const migrationConfirm = (
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

    // TTY input echoes via the terminal; a non-TTY run needs a manual stderr echo.
    yield* output.raw(label, "stderr");
    const line = yield* stdin.readLine(stdin.isTTY ? TTY_TIMEOUT_MILLIS : NON_TTY_TIMEOUT_MILLIS);
    const input = Option.getOrElse(line, () => "");
    if (!stdin.isTTY) yield* output.raw(`${input}\n`, "stderr");
    return parseYesNo(input) ?? options.defaultValue;
  });
