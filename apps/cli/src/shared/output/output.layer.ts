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
import { DateTime, Effect, Fiber, Layer, Option, Schema, Stdio, Stream } from "effect";

import { Tty } from "../runtime/tty.service.ts";
import { CONTEXT_CANCELED_MESSAGE, NonInteractiveError } from "./errors.ts";
import { MachineErrorContext } from "./machine-error-context.service.ts";
import { Output } from "./output.service.ts";
import type { OutputFormat, StreamEvent } from "./types.ts";

const TASK_SPINNER_DELAY_MS = 200;

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = (value: unknown) =>
  encodeJsonString(value).pipe(
    Effect.mapError((error) => new TypeError(error.message, { cause: error })),
    Effect.orDie,
  );

// Reads the opt-in `MachineErrorContext` cell, if any command in this run
// provided it — see that service's doc comment for the envelope contract.
const readMachineErrorContext = Effect.fnUntraced(function* () {
  const context = yield* Effect.serviceOption(MachineErrorContext);
  return Option.isSome(context) ? yield* context.value.get : {};
});

function formatTaskMessage(message: string | undefined): string | undefined {
  if (message === undefined || !message.includes("\n")) {
    return message;
  }

  const guide = `${styleText("gray", "│")}  `;
  const [firstLine, ...rest] = message.split("\n");
  return [firstLine, ...rest.map((line) => `${guide}${line}`)].join("\n");
}

/**
 * Shared by all three layers. The sink waits for `drain`; `process.stdout.write`
 * does not, so a streamed payload piped to a slow consumer buffers in memory.
 */
const stdioWriter =
  (stdio: typeof Stdio.Stdio.Service) =>
  (chunk: string | Uint8Array, stream: "stdout" | "stderr" = "stdout") =>
    Stream.make(chunk).pipe(
      Stream.run(stream === "stderr" ? stdio.stderr() : stdio.stdout()),
      Effect.orDie,
    );

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
    const write = stdioWriter(yield* Stdio.Stdio);
    const scope = yield* Effect.scope;

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
        readonly stream?: "stdout" | "stderr";
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
        // clack defaults these to `process.stdout`; only override when a
        // caller explicitly asks for stderr.
        const clackOutput = behavior.stream === "stderr" ? process.stderr : undefined;
        const value = yield* Effect.promise(() =>
          effectiveMode === "autocomplete"
            ? autocomplete<string>({
                message,
                options: buildAutocompleteOptions(options),
                ...(behavior.placeholder !== undefined
                  ? { placeholder: behavior.placeholder }
                  : {}),
                ...(behavior.maxItems !== undefined ? { maxItems: behavior.maxItems } : {}),
                ...(clackOutput !== undefined ? { output: clackOutput } : {}),
              })
            : select<string>({
                message,
                options: buildSelectOptions(options),
                ...(behavior.maxItems !== undefined ? { maxItems: behavior.maxItems } : {}),
                ...(clackOutput !== undefined ? { output: clackOutput } : {}),
              }),
        );
        if (isCancel(value)) {
          cancel(
            "Operation cancelled.",
            clackOutput !== undefined ? { output: clackOutput } : undefined,
          );
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

    // Writes pause the shown task spinner so they never share its row; the task's final
    // line waits for the last in-flight write.
    interface ShownSpinner {
      handle: ReturnType<typeof spinner>;
      message: string;
      pauses: number;
      settle?: () => void;
    }
    let activeSpinner: ShownSpinner | undefined;

    const pauseSpinner = (): ShownSpinner | undefined => {
      if (activeSpinner === undefined) return undefined;
      if (activeSpinner.pauses === 0) activeSpinner.handle.clear();
      activeSpinner.pauses += 1;
      return activeSpinner;
    };

    // Without the guide, a resume adds no extra `│` line.
    const resumeSpinner = (paused: ShownSpinner | undefined) => {
      if (paused === undefined || paused.pauses === 0) return;
      paused.pauses -= 1;
      if (paused.pauses > 0) return;
      paused.handle = spinner({ withGuide: false });
      paused.handle.start(formatTaskMessage(paused.message));
      paused.settle?.();
    };

    const logAround = (
      emit: (message: string, opts?: { spacing?: number }) => void,
      message: string,
    ) => {
      const paused = pauseSpinner();
      if (paused === undefined) emit(message);
      else emit(message, { spacing: 0 });
      resumeSpinner(paused);
    };

    // A spinner due to appear during an unpaused write waits until such writes finish.
    let unpausedWrites = 0;
    let showWhenIdle: (() => void) | undefined;

    const withSpinnerPaused = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const paused = pauseSpinner();
        if (paused !== undefined)
          return effect.pipe(Effect.ensuring(Effect.sync(() => resumeSpinner(paused))));
        unpausedWrites += 1;
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              unpausedWrites -= 1;
              if (unpausedWrites > 0 || showWhenIdle === undefined) return;
              const show = showWhenIdle;
              showWhenIdle = undefined;
              show();
            }),
          ),
        );
      });

    return Output.of({
      format: "text" as const,
      interactive: tty.stdoutIsTty,
      intro: (title: string) => Effect.sync(() => intro(title)),
      outro: (message: string) => Effect.sync(() => outro(message)),
      info: (message: string) => Effect.sync(() => logAround(log.info, message)),
      warn: (message: string) => Effect.sync(() => logAround(log.warn, message)),
      error: (message: string) => Effect.sync(() => logAround(log.error, message)),
      event: (event: StreamEvent) =>
        (event.type === "log-entry"
          ? Effect.succeed(`[${event.service}] ${event.line}`)
          : encodeJson(event)
        ).pipe(Effect.flatMap((message) => Effect.sync(() => logAround(log.info, message)))),
      task: (message: string) =>
        Effect.gen(function* () {
          let shown = false;
          let settled = false;
          let currentMessage = message;
          let shownSpinner: ShownSpinner | undefined;

          // clack's spinner writes cursor/animation escape codes, so non-TTY stdout
          // gets plain progress lines instead.
          let lastLogged: string | undefined;
          const show = () => {
            if (settled) {
              return;
            }
            if (!tty.stdoutIsTty) {
              lastLogged = currentMessage;
              log.step(currentMessage);
              return;
            }
            shownSpinner = { handle: spinner(), message: currentMessage, pauses: 0 };
            shown = true;
            shownSpinner.handle.start(currentMessage);
            activeSpinner = shownSpinner;
          };

          const pendingStart = yield* Effect.sync(() => {
            if (unpausedWrites > 0) showWhenIdle = show;
            else show();
          }).pipe(
            Effect.delay(TASK_SPINNER_DELAY_MS),
            Effect.forkIn(scope, { startImmediately: true }),
          );

          const finish = (render: () => void) =>
            Effect.sync(() => {
              settled = true;
              const settle = () => {
                render();
                if (activeSpinner === shownSpinner) activeSpinner = undefined;
              };
              if (shownSpinner !== undefined && shownSpinner.pauses > 0)
                shownSpinner.settle = settle;
              else settle();
            }).pipe(Effect.andThen(Fiber.interrupt(pendingStart)));

          return {
            message: (nextMessage: string) =>
              Effect.sync(() => {
                if (settled) {
                  return;
                }
                currentMessage = nextMessage;
                if (shownSpinner !== undefined) {
                  shownSpinner.message = nextMessage;
                  if (shownSpinner.pauses === 0)
                    shownSpinner.handle.message(formatTaskMessage(nextMessage));
                } else if (lastLogged !== undefined && lastLogged !== nextMessage) {
                  // Polling tasks repeat the same message; log only changes.
                  lastLogged = nextMessage;
                  log.step(nextMessage);
                }
              }),
            succeed: (nextMessage?: string) =>
              finish(() => {
                if (shown) {
                  shownSpinner?.handle.stop(formatTaskMessage(nextMessage));
                  return;
                }
                if (nextMessage !== undefined) {
                  log.success(nextMessage);
                }
              }),
            fail: (nextMessage?: string) =>
              finish(() => {
                if (shown) {
                  shownSpinner?.handle.error(formatTaskMessage(nextMessage));
                  return;
                }
                if (nextMessage !== undefined) {
                  log.error(nextMessage);
                }
              }),
            info: (nextMessage?: string) =>
              finish(() => {
                if (shown) {
                  shownSpinner?.handle.clear();
                }
                if (nextMessage !== undefined) {
                  log.info(nextMessage);
                }
              }),
            cancel: (nextMessage?: string) =>
              finish(() => {
                if (shown) {
                  shownSpinner?.handle.cancel(formatTaskMessage(nextMessage));
                  return;
                }
                if (nextMessage !== undefined) {
                  cancel(nextMessage);
                }
              }),
            clear: finish(() => {
              if (shown) {
                shownSpinner?.handle.clear();
              }
            }),
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
          return typeof value === "string" ? value.trim() : "";
        }),
      promptConfirm: (message: string, opts?: { defaultValue?: boolean }) =>
        Effect.gen(function* () {
          const value = yield* Effect.promise(() =>
            confirm({
              message,
              initialValue: opts?.defaultValue,
            }),
          );
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
      result: () => Effect.void,
      success: (message: string) => Effect.sync(() => logAround(log.success, message)),
      fail: (err: { code: string; message: string; detail?: string; suggestion?: string }) =>
        Effect.sync(() => {
          // A command failure is terminal, so a still-shown task spinner is dropped.
          if (activeSpinner !== undefined) {
            activeSpinner.handle.clear();
            activeSpinner.pauses = 0;
            activeSpinner = undefined;
          }
          // Bypasses clack's `log.error` framing (`│` guide + `■` icon): a
          // red-styled message on stderr, optionally followed by a suggestion.
          process.stderr.write(styleText("red", err.message) + "\n");
          if (err.detail !== undefined && err.detail !== err.message) {
            process.stderr.write(styleText("gray", err.detail) + "\n");
          }
          if (err.suggestion !== undefined) {
            process.stderr.write(err.suggestion + "\n");
          } else if (
            err.message !== CONTEXT_CANCELED_MESSAGE &&
            !process.argv.includes("--debug")
          ) {
            // Withheld for the canceled sentinel: declining a prompt is a
            // user decision, not something to troubleshoot.
            process.stderr.write(
              "Try rerunning the command with --debug to troubleshoot the error.\n",
            );
          }
        }),
      raw: (text: string, stream: "stdout" | "stderr" = "stdout") =>
        withSpinnerPaused(write(text, stream)),
      rawBytes: (bytes: Uint8Array, stream: "stdout" | "stderr" = "stdout") =>
        withSpinnerPaused(write(bytes, stream)),
    });
  }),
);

// JSON mode keeps prompts disabled and emits one final machine-readable payload.
export const jsonOutputLayer = Layer.effect(
  Output,
  Effect.gen(function* () {
    const write = stdioWriter(yield* Stdio.Stdio);
    const writeStdout = (s: string) => write(s, "stdout");
    const writeStderr = (s: string) => write(s, "stderr");

    const nonInteractive = (action: string) =>
      Effect.fail(
        new NonInteractiveError({
          detail: `Cannot ${action} in JSON output mode`,
          suggestion: "Provide all required values via flags",
        }),
      );
    const result = (data: unknown) => writeStdout(`${JSON.stringify(data)}\n`);

    return Output.of({
      format: "json" as const,
      interactive: false,
      intro: (title: string) => writeStderr(`${title}\n`),
      outro: (message: string) => writeStderr(`${message}\n`),
      info: (message: string) => writeStderr(`${message}\n`),
      warn: (message: string) => writeStderr(`${message}\n`),
      error: (message: string) => writeStderr(`${message}\n`),
      event: (event: StreamEvent) =>
        encodeJson(event).pipe(Effect.flatMap((json) => writeStderr(`${json}\n`))),
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
          clear: Effect.void,
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
      result,
      success: (message: string, data?: Record<string, unknown>) => result({ ...data, message }),
      fail: (err: { code: string; message: string; detail?: string; suggestion?: string }) =>
        Effect.gen(function* () {
          const extra = yield* readMachineErrorContext();
          // `extra` spreads first so the envelope's own `_tag`/`error` can't
          // be clobbered by a same-named context field.
          const json = yield* encodeJson({ ...extra, _tag: "Error", error: err });
          yield* writeStdout(json + "\n");
        }),
      raw: (text: string, stream: "stdout" | "stderr" = "stdout") => write(text, stream),
      rawBytes: (bytes: Uint8Array, stream: "stdout" | "stderr" = "stdout") => write(bytes, stream),
    });
  }),
);

// Stream JSON mode emits logs, progress, and results as timestamped NDJSON events.
export const streamJsonOutputLayer = Layer.effect(
  Output,
  Effect.gen(function* () {
    const write = stdioWriter(yield* Stdio.Stdio);
    const writeStdout = (s: string) => write(s, "stdout");
    const emitEvent = (event: (timestamp: string) => StreamEvent, extra: object = {}) =>
      DateTime.now.pipe(
        Effect.flatMap((now) => encodeJson({ ...extra, ...event(DateTime.formatIso(now)) })),
        Effect.flatMap((json) => writeStdout(json + "\n")),
      );
    const emitLog = (level: "info" | "warn" | "success" | "error", message: string) =>
      emitEvent((timestamp) => ({ type: "log", level, message, timestamp }));

    const nonInteractive = (action: string) =>
      Effect.fail(
        new NonInteractiveError({
          detail: `Cannot ${action} in stream-json output mode`,
          suggestion: "Provide all required values via flags",
        }),
      );
    const result = (data: unknown) =>
      emitEvent((timestamp) => ({ type: "result", data, timestamp }));

    return Output.of({
      format: "stream-json" as const,
      interactive: false,
      intro: (title: string) => emitLog("info", title),
      outro: (message: string) => emitLog("info", message),
      info: (message: string) => emitLog("info", message),
      warn: (message: string) => emitLog("warn", message),
      error: (message: string) => emitLog("error", message),
      event: (event: StreamEvent) =>
        encodeJson(event).pipe(Effect.flatMap((json) => writeStdout(json + "\n"))),
      task: (message: string) =>
        Effect.sync(() => ({
          message: (nextMessage: string) => emitLog("info", nextMessage),
          succeed: (nextMessage?: string) => emitLog("success", nextMessage ?? "Task completed."),
          fail: (nextMessage?: string) => emitLog("error", nextMessage ?? "Task failed."),
          info: (nextMessage?: string) => emitLog("info", nextMessage ?? "Task completed."),
          cancel: (nextMessage?: string) => emitLog("warn", nextMessage ?? "Task cancelled."),
          clear: Effect.void,
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
            const at = current;
            return emitEvent((timestamp) => ({
              type: "progress",
              status,
              current: at,
              max: opts.max,
              message,
              timestamp,
            }));
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
      result,
      success: (message: string, data?: Record<string, unknown>) => result({ ...data, message }),
      fail: (err: { code: string; message: string; detail?: string; suggestion?: string }) =>
        Effect.gen(function* () {
          const extra = yield* readMachineErrorContext();
          // `extra` spreads first so the event's own `type`/`error`/`timestamp`
          // can't be clobbered by a same-named context field.
          yield* emitEvent((timestamp) => ({ type: "error", error: err, timestamp }), extra);
        }),
      raw: (text: string, stream: "stdout" | "stderr" = "stdout") => write(text, stream),
      rawBytes: (bytes: Uint8Array, stream: "stdout" | "stderr" = "stdout") => write(bytes, stream),
    });
  }),
);

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
