import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  password,
  progress as clackProgress,
  text,
} from "@clack/prompts";
import { Effect, Layer, Stdio, Stream } from "effect";

import { Tty } from "../runtime/tty.service.ts";
import { NonInteractiveError } from "./errors.ts";
import { Output } from "./output.service.ts";
import type { OutputFormat, StreamEvent } from "./types.ts";

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

    return Output.of({
      format: "text" as const,
      interactive: tty.stdoutIsTty,
      intro: (title: string) => Effect.sync(() => intro(title)),
      outro: (message: string) => Effect.sync(() => outro(message)),
      info: (message: string) => Effect.sync(() => log.info(message)),
      warn: (message: string) => Effect.sync(() => log.warn(message)),
      error: (message: string) => Effect.sync(() => log.error(message)),
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
      fail: () => Effect.void,
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
      promptText: () => nonInteractive("prompt for input"),
      promptPassword: () => nonInteractive("prompt for password"),
      promptConfirm: () => nonInteractive("prompt for confirmation"),
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
      promptText: () => nonInteractive("prompt for input"),
      promptPassword: () => nonInteractive("prompt for password"),
      promptConfirm: () => nonInteractive("prompt for confirmation"),
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
