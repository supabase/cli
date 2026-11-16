import { Effect, Layer } from "effect";
import { CliOutput } from "effect/cli";
import type { ColorStream } from "../../command-internal/colors.ts";
import type { CliErrorSuggestionContext } from "../cli/subcommand-flag-suggestions.ts";
import { textCliOutputFormatter } from "./text-formatter.ts";

/** Selects help colors for the stream used by the CLI's parse-error console routing. */
export function textCliOutputLayer(
  context: CliErrorSuggestionContext,
  streams: { readonly stdout: ColorStream; readonly stderr: ColorStream } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
  agentMode = false,
) {
  const stdout = textCliOutputFormatter(context, streams.stdout, agentMode);
  const stderr = textCliOutputFormatter(context, streams.stderr, agentMode);
  return Layer.mergeAll(
    CliOutput.layer(stdout),
    CliOutput.layerPresenter({
      present: Effect.fn("CliOutput.present")(function* (event) {
        // Invalid-invocation help is either suppressed or replayed to stderr by run.ts.
        yield* CliOutput.defaultPresenter
          .present(event)
          .pipe(
            Effect.provideService(
              CliOutput.Formatter,
              event._tag === "InvalidInvocation" ? stderr : stdout,
            ),
          );
      }),
    }),
  );
}
