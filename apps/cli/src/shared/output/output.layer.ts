import {
  autocomplete,
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  password,
  progress as clackProgress,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { styleText } from "node:util";
import { Effect, Layer, Stdio, Stream } from "effect";

import { Tty } from "../runtime/tty.service.ts";
import { NonInteractiveError } from "./errors.ts";
import { Output } from "./output.service.ts";
import type { OutputFormat, StreamEvent } from "./types.ts";

const TASK_SPINNER_DELAY_MS = 200;

function formatTaskMessage(message: string | undefined): string | undefined {
  if (message === undefined || !message.includes("\n")) {
    return message;
  }

  const guide = `${styleText("gray", "│")}  `;
  const [firstLine, ...rest] = message.split("\n");
  return [firstLine, ...rest.map((line) => `${guide}${line}`)].join("\n");
}

/**
 * Output layers - Concrete output mode implementations for the CLI.
 *
 * Each layer binds the shared `Output` contract to one transport policy:
 * interactive terminal output, single-shot JSON, or NDJSON streaming.
 */
export const textOutputLayer = Layer.effect(
  Output,
  Effect.gen(function* () {
    const tty = yield* Tty;
    const DEFAULT_AUTOCOMPLETE_THRESHOLD = 10;
    const buildSelectOptions = (
      options: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly hint?: string;
      }>,
    ): Parameters<typeof select<string>>[0]["options"] =>
      options.map((option) => {
        const clackOption: Parameters<typeof select<string>>[0]["options"][number] = {
          value: option.value,
          label: option.label,
        };
        if (option.hint !== undefined) {
          clackOption.hint = option.hint;
        }
        return clackOption;
      });
    const buildAutocompleteOptions = (
      options: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly hint?: string;
      }>,
    ) =>
      options.map((option) => {
        const clackOption: {
          value: string;
          label: string;
          hint?: string;
        } = {
          value: option.value,
          label: option.label,
        };
        if (option.hint !== undefined) {
          clackOption.hint = option.hint;
        }
        return clackOption;
      });

    const buildMultiSelectOptions = (
      options: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly hint?: string;
      }>,
    ): Parameters<typeof multiselect<string>>[0]["options"] =>
      options.map((option) => {
        const clackOption: Parameters<typeof multiselect<string>>[0]["options"][number] = {
          value: option.value,
          label: option.label,
        };
        if (option.hint !== undefined) {
          clackOption.hint = option.hint;
        }
        return clackOption;
      });
    const promptSelect = (
      message: string,
      options: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly hint?: string;
      }>,
      behavior: {
        readonly mode?: "auto" | "select" | "autocomplete";
        readonly autocompleteThreshold?: number;
        readonly placeholder?: string;
        readonly maxItems?: number;
      } = {},
    ) =>
      Effect.gen(function* () {
        const mode = behavior.mode ?? "auto";
        const effectiveMode =
          mode === "auto"
            ? options.length > (behavior.autocompleteThreshold ?? DEFAULT_AUTOCOMPLETE_THRESHOLD)
              ? "autocomplete"
              : "select"
            : mode;
        const value = yield* Effect.promise(() =>
          effectiveMode === "autocomplete"
            ? autocomplete<string>({
                message,
                options: buildAutocompleteOptions(options),
                ...(behavior.placeholder !== undefined
                  ? { placeholder: behavior.placeholder }
                  : {}),
                ...(behavior.maxItems !== undefined ? { maxItems: behavior.maxItems } : {}),
              })
            : select<string>({
                message,
                options: buildSelectOptions(options),
                ...(behavior.maxItems !== undefined ? { maxItems: behavior.maxItems } : {}),
              }),
        );
        if (isCancel(value)) {
          cancel("Operation cancelled.");
          return yield* Effect.interrupt;
        }
        return value;
      });

    const promptMultiSelect = (
      message: string,
      options: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly hint?: string;
      }>,
    ) =>
      Effect.gen(function* () {
        const value = yield* Effect.promise(() =>
          multiselect<string>({
            message,
            options: buildMultiSelectOptions(options),
          }),
        );
        if (isCancel(value)) {
          cancel("Operation cancelled.");
          return yield* Effect.interrupt;
        }
        return value;
      });

    return Output.of({
      format: "text" as const,
      interactive: tty.stdoutIsTty,
      intro: (title: string) => Effect.sync(() => intro(title)),
      outro: (message: string) => Effect.sync(() => outro(message)),
      info: (message: string) => Effect.sync(() => log.info(message)),
      warn: (message: string) => Effect.sync(() => log.warn(message)),
      error: (message: string) => Effect.sync(() => log.error(message)),
      event: (event: StreamEvent) =>
        event.type === "log-entry"
          ? Effect.sync(() => log.info(`[${event.service}] ${event.line}`))
          : Effect.sync(() => log.info(JSON.stringify(event))),
      task: (message: string) =>
        Effect.sync(() => {
          if (!tty.stdoutIsTty) {
            // Non-TTY stdout (CI, pipe, redirect) — suppress the @clack spinner,
            // which writes cursor-hide and animated-frame ANSI to stdout and
            // pollutes machine-parsed output. See supabase/cli#5397.
            const noop = () => Effect.void;
            return {
              message: noop,
              succeed: noop,
              fail: noop,
              info: noop,
              cancel: noop,
              clear: noop,
            };
          }
          let shown = false;
          let settled = false;
          let currentMessage = message;
          let task: ReturnType<typeof spinner> | undefined;
          let timeout: ReturnType<typeof setTimeout> | undefined;

          const cancelPendingStart = () => {
            if (timeout !== undefined) {
              clearTimeout(timeout);
              timeout = undefined;
            }
          };

          const finish = (render: () => void) => {
            settled = true;
            cancelPendingStart();
            render();
          };

          timeout = setTimeout(() => {
            if (settled) {
              return;
            }
            task = spinner();
            shown = true;
            task.start(currentMessage);
            timeout = undefined;
          }, TASK_SPINNER_DELAY_MS);

          return {
            message: (nextMessage: string) =>
              Effect.sync(() => {
                if (settled) {
                  return;
                }
                currentMessage = nextMessage;
                if (shown) {
                  task?.message(formatTaskMessage(nextMessage));
                }
              }),
            succeed: (nextMessage?: string) =>
              Effect.sync(() =>
                finish(() => {
                  if (shown) {
                    task?.stop(formatTaskMessage(nextMessage));
                    return;
                  }
                  if (nextMessage !== undefined) {
                    log.success(nextMessage);
                  }
                }),
              ),
            fail: (nextMessage?: string) =>
              Effect.sync(() =>
                finish(() => {
                  if (shown) {
                    task?.error(formatTaskMessage(nextMessage));
                    return;
                  }
                  if (nextMessage !== undefined) {
                    log.error(nextMessage);
                  }
                }),
              ),
            info: (nextMessage?: string) =>
              Effect.sync(() =>
                finish(() => {
                  if (shown) {
                    task?.clear();
                  }
                  if (nextMessage !== undefined) {
                    log.info(nextMessage);
                  }
                }),
              ),
            cancel: (nextMessage?: string) =>
              Effect.sync(() =>
                finish(() => {
                  if (shown) {
                    task?.cancel(formatTaskMessage(nextMessage));
                    return;
                  }
                  if (nextMessage !== undefined) {
                    cancel(nextMessage);
                  }
                }),
              ),
            clear: () =>
              Effect.sync(() =>
                finish(() => {
                  if (shown) {
                    task?.clear();
                  }
                }),
              ),
          };
        }),
      promptText: (
        message: string,
        opts?: { validate?: (v: string) => string | undefined; defaultValue?: string },
      ) =>
        Effect.gen(function* () {
          const value = yield* Effect.promise(() =>
            text({
              message,
              validate: opts?.validate
                ? (v: string | undefined) => opts.validate!(v ?? "")
                : undefined,
              defaultValue: opts?.defaultValue,
            }),
          );
          if (isCancel(value)) {
            cancel("Operation cancelled.");
            return yield* Effect.interrupt;
          }
          return value;
        }),
      promptPassword: (message: string) =>
        Effect.gen(function* () {
          const value = yield* Effect.promise(() => password({ message }));
          if (isCancel(value)) {
            cancel("Operation cancelled.");
            return yield* Effect.interrupt;
          }
          return value.trim();
        }),
      promptConfirm: (message: string) =>
        Effect.gen(function* () {
          const value = yield* Effect.promise(() => confirm({ message }));
          if (isCancel(value)) {
            cancel("Operation cancelled.");
            return yield* Effect.interrupt;
          }
          return value;
        }),
      promptSelect,
      promptMultiSelect,
      progress: (opts: { max: number }) =>
        Effect.sync(() => {
          const bar = clackProgress({ max: opts.max, style: "heavy" });
          return {
            start: (msg: string) => Effect.sync(() => bar.start(msg)),
            advance: (step: number, msg?: string) => Effect.sync(() => bar.advance(step, msg)),
            message: (msg: string) => Effect.sync(() => bar.message(msg)),
            stop: (msg: string) => Effect.sync(() => bar.stop(msg)),
          };
        }),
      success: (message: string) => Effect.sync(() => log.success(message)),
      fail: (err: { code: string; message: string; detail?: string; suggestion?: string }) =>
        Effect.sync(() => {
          // Matches Go's `recoverAndExit` (apps/cli-go/cmd/root.go:300-303): a
          // red-styled message on stderr, optionally followed by a suggestion.
          // Bypasses clack's `log.error` framing (`│` guide + `■` icon) so the
          // output byte-matches the Go CLI for parity tests.
          process.stderr.write(styleText("red", err.message) + "\n");
          if (err.detail !== undefined && err.detail !== err.message) {
            process.stderr.write(styleText("gray", err.detail) + "\n");
          }
          if (err.suggestion !== undefined) {
            process.stderr.write(err.suggestion + "\n");
          } else if (!process.argv.includes("--debug")) {
            // Go's `utils.SuggestDebugFlag` (apps/cli-go/internal/utils/misc.go:41).
            process.stderr.write(
              "Try rerunning the command with --debug to troubleshoot the error.\n",
            );
          }
        }),
      raw: (text: string, stream: "stdout" | "stderr" = "stdout") =>
        Effect.sync(() => {
          if (stream === "stderr") {
            process.stderr.write(text);
          } else {
            process.stdout.write(text);
          }
        }),
    });
  }),
);

// JSON mode keeps prompts disabled and emits one final machine-readable payload.
export const jsonOutputLayer = Layer.effect(
  Output,
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;

    const writeStdout = (s: string) =>
      Stream.make(s).pipe(Stream.run(stdio.stdout()), Effect.orDie);
    const writeStderr = (s: string) =>
      Stream.make(s).pipe(Stream.run(stdio.stderr()), Effect.orDie);

    const nonInteractive = (action: string) =>
      Effect.fail(
        new NonInteractiveError({
          detail: `Cannot ${action} in JSON output mode`,
          suggestion: "Provide all required values via flags",
        }),
      );

    return Output.of({
      format: "json" as const,
      interactive: false,
      intro: (title: string) => writeStderr(`${title}\n`),
      outro: (message: string) => writeStderr(`${message}\n`),
      info: (message: string) => writeStderr(`${message}\n`),
      warn: (message: string) => writeStderr(`${message}\n`),
      error: (message: string) => writeStderr(`${message}\n`),
      event: (event: StreamEvent) => writeStderr(`${JSON.stringify(event)}\n`),
      task: (message: string) =>
        Effect.sync(() => ({
          message: (nextMessage: string) => writeStderr(`[task] ${nextMessage}\n`),
          succeed: (nextMessage?: string) =>
            nextMessage ? writeStderr(`[task] done: ${nextMessage}\n`) : Effect.void,
          fail: (nextMessage?: string) =>
            nextMessage ? writeStderr(`[task] failed: ${nextMessage}\n`) : Effect.void,
          info: (nextMessage?: string) =>
            nextMessage ? writeStderr(`${nextMessage}\n`) : Effect.void,
          cancel: (nextMessage?: string) =>
            nextMessage ? writeStderr(`[task] cancelled: ${nextMessage}\n`) : Effect.void,
          clear: () => Effect.void,
        })).pipe(Effect.tap(() => writeStderr(`[task] start: ${message}\n`))),
      promptText: () => nonInteractive("prompt for input"),
      promptPassword: () => nonInteractive("prompt for password"),
      promptConfirm: () => nonInteractive("prompt for confirmation"),
      promptSelect: () => nonInteractive("prompt for a selection"),
      promptMultiSelect: () => nonInteractive("prompt for a multi-selection"),
      progress: (opts: { max: number }) =>
        Effect.sync(() => {
          let current = 0;
          return {
            start: (msg: string) => writeStderr(`[progress] start (0/${opts.max}): ${msg}\n`),
            advance: (step: number, msg?: string) => {
              current += step;
              return writeStderr(`[progress] ${current}/${opts.max}${msg ? `: ${msg}` : ""}\n`);
            },
            message: (msg: string) => writeStderr(`[progress] ${msg}\n`),
            stop: (msg: string) => writeStderr(`[progress] done: ${msg}\n`),
          };
        }),
      success: (message: string, data?: Record<string, unknown>) =>
        writeStdout(JSON.stringify({ ...data, message }) + "\n"),
      fail: (err: { code: string; message: string; detail?: string; suggestion?: string }) =>
        writeStdout(JSON.stringify({ _tag: "Error", error: err }) + "\n"),
      raw: (text: string, stream: "stdout" | "stderr" = "stdout") =>
        stream === "stderr" ? writeStderr(text) : writeStdout(text),
    });
  }),
);

// Stream JSON mode emits logs, progress, and results as timestamped NDJSON events.
export const streamJsonOutputLayer = Layer.effect(
  Output,
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;

    const writeStdout = (s: string) =>
      Stream.make(s).pipe(Stream.run(stdio.stdout()), Effect.orDie);
    const writeStderr = (s: string) =>
      Stream.make(s).pipe(Stream.run(stdio.stderr()), Effect.orDie);
    const emitLog = (level: "info" | "warn" | "success" | "error", message: string) => {
      const event: StreamEvent = {
        type: "log",
        level,
        message,
        timestamp: new Date().toISOString(),
      };
      return writeStdout(JSON.stringify(event) + "\n");
    };

    const nonInteractive = (action: string) =>
      Effect.fail(
        new NonInteractiveError({
          detail: `Cannot ${action} in stream-json output mode`,
          suggestion: "Provide all required values via flags",
        }),
      );

    return Output.of({
      format: "stream-json" as const,
      interactive: false,
      intro: (title: string) => emitLog("info", title),
      outro: (message: string) => emitLog("info", message),
      info: (message: string) => emitLog("info", message),
      warn: (message: string) => emitLog("warn", message),
      error: (message: string) => emitLog("error", message),
      event: (event: StreamEvent) => writeStdout(JSON.stringify(event) + "\n"),
      task: (message: string) =>
        Effect.sync(() => ({
          message: (nextMessage: string) => emitLog("info", nextMessage),
          succeed: (nextMessage?: string) => emitLog("success", nextMessage ?? "Task completed."),
          fail: (nextMessage?: string) => emitLog("error", nextMessage ?? "Task failed."),
          info: (nextMessage?: string) => emitLog("info", nextMessage ?? "Task completed."),
          cancel: (nextMessage?: string) => emitLog("warn", nextMessage ?? "Task cancelled."),
          clear: () => Effect.void,
        })).pipe(Effect.tap(() => emitLog("info", message))),
      promptText: () => nonInteractive("prompt for input"),
      promptPassword: () => nonInteractive("prompt for password"),
      promptConfirm: () => nonInteractive("prompt for confirmation"),
      promptSelect: () => nonInteractive("prompt for a selection"),
      promptMultiSelect: () => nonInteractive("prompt for a multi-selection"),
      progress: (opts: { max: number }) =>
        Effect.sync(() => {
          let current = 0;
          const emit = (status: "start" | "active" | "done", message: string) => {
            const event: StreamEvent = {
              type: "progress",
              status,
              current,
              max: opts.max,
              message,
              timestamp: new Date().toISOString(),
            };
            return writeStdout(JSON.stringify(event) + "\n");
          };

          return {
            start: (msg: string) => emit("start", msg),
            advance: (step: number, msg?: string) => {
              current += step;
              return emit("active", msg ?? "");
            },
            message: (msg: string) => emit("active", msg),
            stop: (msg: string) => emit("done", msg),
          };
        }),
      success: (message: string, data?: Record<string, unknown>) =>
        writeStdout(
          JSON.stringify({
            type: "result",
            data: { ...data, message },
            timestamp: new Date().toISOString(),
          }) + "\n",
        ),
      fail: (err: { code: string; message: string; detail?: string; suggestion?: string }) => {
        const event: StreamEvent = {
          type: "error",
          error: err,
          timestamp: new Date().toISOString(),
        };
        return writeStdout(JSON.stringify(event) + "\n");
      },
      raw: (text: string, stream: "stdout" | "stderr" = "stdout") =>
        stream === "stderr" ? writeStderr(text) : writeStdout(text),
    });
  }),
);

// Select the concrete output policy from the parsed global flag.
export function outputLayerFor(
  format: OutputFormat,
): Layer.Layer<Output, never, Stdio.Stdio | Tty> {
  switch (format) {
    case "text":
      return textOutputLayer;
    case "json":
      return jsonOutputLayer;
    case "stream-json":
      return streamJsonOutputLayer;
  }
}
