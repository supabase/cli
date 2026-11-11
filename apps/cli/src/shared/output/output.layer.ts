import { stripVTControlCharacters } from "node:util";
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
  updateSettings,
} from "@clack/prompts";
import { Writable } from "node:stream";
import { styleText } from "node:util";
import {
  DateTime,
  Clock,
  Effect,
  Fiber,
  Layer,
  Option,
  PlatformError,
  References,
  Schema,
  Stdio,
  Stream,
} from "effect";

import { muted } from "../../command-internal/colors.ts";
import { formatDuration } from "../../command-internal/duration.ts";
import { CLI_VERSION } from "../cli/version.ts";
import { type Glyph, errorBlock, gutterStream, indentLines, statusLine } from "./gutter.ts";
import { pickOne, pickWithSearch } from "./picker.ts";
import { leaveDebugRun } from "./debug-run.ts";
import { Tty } from "../runtime/tty.service.ts";
import { CommandTarget } from "./command-target.service.ts";
import { CONTEXT_CANCELED_MESSAGE, NonInteractiveError, StdoutClosedError } from "./errors.ts";
import { MachineErrorContext } from "./machine-error-context.service.ts";
import type { PlanGateEntitlement } from "./normalize-error.ts";
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

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Adds the announced target to a plain-object result; arrays, scalars and an own `target` stay. */
const withCommandTarget = Effect.fnUntraced(function* (data: unknown) {
  if (!isPlainObject(data) || data.target !== undefined) return data;
  const cell = yield* Effect.serviceOption(CommandTarget);
  if (Option.isNone(cell)) return data;
  const target = yield* cell.value.json;
  return Option.isSome(target) ? { ...data, target: target.value } : data;
});

/** Renders a clack call into a string instead of writing it to `process.stdout`. */
function renderClack(draw: (output: Writable) => void): string {
  let rendered = "";
  draw(
    new Writable({
      write(chunk, _encoding, done) {
        rendered += String(chunk);
        done();
      },
    }),
  );
  return rendered;
}

const HTTP_STATUS_TEXT: Readonly<Record<string, string>> = {
  "400": "Bad Request",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "Not Found",
  "409": "Conflict",
  "422": "Unprocessable Entity",
  "429": "Too Many Requests",
  "500": "Internal Server Error",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
};

/**
 * Rewords the established `unexpected <action> status <code>: <body>` failures for people: the
 * action and status as the headline, the response body as detail.
 */
function readableHttpFailure(message: string): { message: string; detail?: string } {
  const match = /^unexpected (.+?) status (\d{3}): ?([\s\S]*)$/.exec(message);
  if (match === null) {
    // A response body glued to the headline moves to the detail line.
    const body = /^(.+?): (\{[\s\S]*\})$/.exec(message);
    return body === null ? { message } : { message: `${body[1]}.`, detail: body[2] ?? "" };
  }
  const [, action = "", status = "", body = ""] = match;
  const statusText = HTTP_STATUS_TEXT[status];
  return {
    message: `Couldn't ${action}. The API returned ${status}${statusText ? ` ${statusText}` : ""}.`,
    ...(body.trim() === "" ? {} : { detail: body.trim() }),
  };
}

/**
 * Redraws an established `Warning: …` line as a `!` status line when a person reads stderr on a
 * terminal, so every warning follows the gutter without each caller changing.
 */
function asGutterWarning(text: string): string {
  if (!process.stderr.isTTY) return text;
  const plain = stripVTControlCharacters(text);
  if (!plain.startsWith("Warning: ")) return text;
  return statusLine("warning", plain.slice("Warning: ".length).replace(/\n$/, ""), process.stderr);
}

const OUTCOME_VERB =
  /^(Created|Deleted|Disabled|Enabled|Updated|Finished|Removed|Linked|Unlinked|Deployed|Pushed|Applied|Restored|Paused|Unpaused|Set|Unset|Reverified|Activated|Saved|Wrote|Generated|Started|Stopped|Renamed|Uploaded|Downloaded|Copied|Moved|Repaired|Squashed|Reset|Signed|Logged|Successfully)\b/;

/**
 * Redraws an established one-line outcome (`Disabled preview branching for project: …`) as a `✓`
 * result line with a blank line above it, so every command's result looks the same on a terminal.
 */
function asGutterOutcome(text: string): string {
  const plain = stripVTControlCharacters(text).replace(/\n$/, "");
  if (plain.includes("\n") || !OUTCOME_VERB.test(plain)) return text;
  // "Deleted preview branch: abc" reads as "Deleted preview branch abc"; a dangling colon goes.
  const sentence = plain.replace(/:\s*$/, "").replace(/: (\S+)$/, " $1");
  return `\n${statusLine("success", sentence)}`;
}

const SECRET_FLAG = /pass|token|key|secret/i;

/** The invoked command with `--debug` added; values of secret-looking flags are left out. */
function rerunWithDebug(): string {
  const args = process.argv.slice(2);
  const shown = args.map((arg, index) => {
    const previous = args[index - 1] ?? "";
    if (/^--?[\w-]+=/.test(arg) && SECRET_FLAG.test(arg.split("=")[0] ?? "")) {
      return `${arg.split("=")[0]}=…`;
    }
    return previous.startsWith("-") && SECRET_FLAG.test(previous) && !arg.startsWith("-")
      ? "…"
      : arg;
  });
  return ["supabase", ...shown, "--debug"].join(" ");
}

/** The command a text run opens with on a terminal: its space-joined path and short description. */
export interface CommandHeader {
  readonly path: string;
  readonly description: string;
}

function formatTaskMessage(message: string | undefined): string | undefined {
  if (message === undefined || !message.includes("\n")) {
    return message;
  }

  const guide = `${styleText("gray", "│")}  `;
  const [firstLine, ...rest] = message.split("\n");
  return [firstLine, ...rest.map((line) => `${guide}${line}`)].join("\n");
}

// libuv reports a write to a pipe whose reader exited as `EOF` on Windows (`ERROR_BROKEN_PIPE`).
const brokenPipeCodes: ReadonlySet<unknown> = new Set(["EPIPE", "EOF"]);

const isBrokenPipe = (error: PlatformError.PlatformError): boolean => {
  const cause = error.reason.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    brokenPipeCodes.has(cause.code)
  );
};

/* A direct write (clack's progress lines, `--debug`) can meet the closed pipe first and leave the
   process stream errored, and the sink would then wait forever for `drain`. Bun sets `errored` a
   tick after that write, so nothing may yield between this check and the sink's `error` listener. */
export const writeStdio = (
  stdio: typeof Stdio.Stdio.Service,
  stream: "stdout" | "stderr",
  chunk: string | Uint8Array,
) =>
  Effect.suspend(() => {
    const errored = process[stream].errored;
    if (errored !== null) {
      return Effect.fail(
        PlatformError.systemError({
          module: "Stdio",
          method: stream,
          _tag: "Unknown",
          cause: errored,
        }),
      );
    }
    return Stream.make(chunk).pipe(
      Stream.run(stream === "stderr" ? stdio.stderr() : stdio.stdout()),
    );
  }).pipe(Effect.provideService(References.PreventSchedulerYield, true));

/* Keyed by the Stdio service so output layers sharing one skip a stream any of them saw close.
   Layers on another Stdio (run.ts builds the final-error layer on its own) see it via `errored`. */
const closedStreams = new WeakMap<typeof Stdio.Stdio.Service, Set<"stdout" | "stderr">>();

/**
 * Shared by all three layers. The sink waits for `drain`; `process.stdout.write`
 * does not, so a streamed payload piped to a slow consumer buffers in memory.
 *
 * A closed stream never emits `drain` or `error` again, so writes to it are skipped rather than
 * left to hang. A closed stdout also ends the command with `StdoutClosedError`; a closed stderr
 * only drops diagnostics.
 */
const stdioWriter = (stdio: typeof Stdio.Stdio.Service) => {
  const closed = closedStreams.get(stdio) ?? new Set();
  closedStreams.set(stdio, closed);
  return (chunk: string | Uint8Array, stream: "stdout" | "stderr" = "stdout") =>
    Effect.suspend(() =>
      closed.has(stream)
        ? Effect.void
        : writeStdio(stdio, stream, chunk).pipe(
            Effect.catchIf(isBrokenPipe, () =>
              Effect.sync(() => closed.add(stream)).pipe(
                Effect.andThen(
                  stream === "stdout" ? Effect.die(new StdoutClosedError()) : Effect.void,
                ),
              ),
            ),
            Effect.orDie,
          ),
    );
};

/**
 * Output layers - Concrete output mode implementations for the CLI.
 *
 * Each layer binds the shared `Output` contract to one transport policy:
 * interactive terminal output, single-shot JSON, or NDJSON streaming.
 */
const makeTextOutput = (header: CommandHeader | undefined) =>
  Effect.gen(function* () {
    const tty = yield* Tty;
    const writeRaw = stdioWriter(yield* Stdio.Stdio);
    // Normal output after a run of debug lines starts with a blank line.
    const write = (chunk: string | Uint8Array, stream: "stdout" | "stderr" = "stdout") =>
      writeRaw(typeof chunk === "string" ? `${leaveDebugRun(chunk)}${chunk}` : chunk, stream);
    const scope = yield* Effect.scope;

    // On a terminal, output follows the status gutter in gutter.ts: a glyph in column 0, text from
    // column 2, and no clack guide lines. Piped output keeps clack's plain log lines.
    const gutter = tty.stdoutIsTty;
    if (gutter) updateSettings({ withGuide: false });
    const statusEmitter =
      (glyph: Glyph) =>
      (message: string, opts: { output: Writable } = { output: process.stdout }) => {
        opts.output.write(`${leaveDebugRun()}${statusLine(glyph, message)}`);
      };
    const statusLog = gutter
      ? {
          // The outcome starts a new phase, so a blank line separates it from what came before.
          success: (message: string, opts: { output: Writable } = { output: process.stdout }) => {
            opts.output.write("\n");
            statusEmitter("success")(message, opts);
          },
          info: statusEmitter("none"),
          warn: statusEmitter("warning"),
          error: statusEmitter("error"),
        }
      : log;
    const promptOutput = (stream: NodeJS.WriteStream = process.stdout) =>
      gutter
        ? { output: gutterStream(stream) }
        : stream === process.stdout
          ? {}
          : { output: stream };
    // A command run on a terminal opens with the CLI version and its description, on stderr, before
    // its first output.
    // The description shows how long the command took to reach its first output, unless a prompt
    // came first: time spent waiting on a person says nothing about the command.
    let opened = !gutter || header === undefined;
    let timed = true;
    const startedAt = yield* Clock.currentTimeMillis;
    const open = Effect.gen(function* () {
      if (opened || header === undefined) return;
      opened = true;
      const took = (yield* Clock.currentTimeMillis) - startedAt;
      const timing = timed
        ? ` ${muted(`[${formatDuration(Math.round(took) * 1_000_000)}]`, process.stderr)}`
        : "";
      yield* write(
        `${muted(`Supabase CLI ${CLI_VERSION}`, process.stderr)}\n\n${statusLine("context", `${header.description}${timing}`, process.stderr)}`,
        "stderr",
      );
    });
    // A command that fails before any output still opens, so its error sits under its description.
    yield* Effect.addFinalizer(() => open.pipe(Effect.ignore));
    const openForPrompt = Effect.suspend(() => {
      timed = false;
      return open;
    });
    const afterOpen = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      open.pipe(Effect.andThen(effect));

    const DEFAULT_AUTOCOMPLETE_THRESHOLD = 10;
    // clack otherwise fills the terminal's height with options.
    const DEFAULT_MAX_ITEMS = 8;
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
        const prompted = promptOutput(clackOutput);
        if (gutter) {
          const picked = yield* (effectiveMode === "autocomplete" ? pickWithSearch : pickOne)(
            message,
            options,
            {
              maxItems: behavior.maxItems ?? DEFAULT_MAX_ITEMS,
              stream: clackOutput ?? process.stdout,
            },
          );
          if (picked === undefined) {
            return yield* Effect.interrupt;
          }
          return picked;
        }
        const value = yield* Effect.promise(() =>
          effectiveMode === "autocomplete"
            ? autocomplete<string>({
                message,
                options: buildAutocompleteOptions(options),
                ...(behavior.placeholder !== undefined
                  ? { placeholder: behavior.placeholder }
                  : {}),
                maxItems: behavior.maxItems ?? DEFAULT_MAX_ITEMS,
                ...prompted,
              })
            : select<string>({
                message,
                options: buildSelectOptions(options),
                maxItems: behavior.maxItems ?? DEFAULT_MAX_ITEMS,
                ...prompted,
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
            ...promptOutput(),
            message,
            options: buildMultiSelectOptions(options),
            maxItems: DEFAULT_MAX_ITEMS,
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

    // A spinner due to appear during an unpaused write waits until such writes finish.
    let unpausedWrites = 0;
    let showWhenIdle: (() => void) | undefined;

    const withSpinnerPaused = <A, E, R>(
      makeEffect: (spinnerPaused: boolean) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const paused = pauseSpinner();
        if (paused !== undefined)
          return makeEffect(true).pipe(Effect.ensuring(Effect.sync(() => resumeSpinner(paused))));
        unpausedWrites += 1;
        return makeEffect(false).pipe(
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

    // clack writes to `process.stdout` itself; rendering into a buffer sends the line through
    // `write`, which handles a closed stdout.
    const logAround = (
      emit: (message: string, opts: { spacing?: number; output: Writable }) => void,
      message: string,
    ) =>
      afterOpen(
        withSpinnerPaused((spinnerPaused) =>
          write(
            renderClack((output) =>
              emit(message, spinnerPaused ? { spacing: 0, output } : { output }),
            ),
          ),
        ),
      );

    return Output.of({
      format: "text" as const,
      interactive: tty.stdoutIsTty,
      intro: (title: string) => (gutter ? open : Effect.sync(() => intro(title))),
      outro: (message: string) =>
        Effect.sync(() => {
          if (gutter) statusLog.success(message);
          else outro(message);
        }),
      info: (message: string) => logAround(statusLog.info, message),
      warn: (message: string) => logAround(statusLog.warn, message),
      error: (message: string) => logAround(statusLog.error, message),
      event: (event: StreamEvent) =>
        (event.type === "log-entry"
          ? Effect.succeed(`[${event.service}] ${event.line}`)
          : encodeJson(event)
        ).pipe(Effect.flatMap((message) => logAround(statusLog.info, message))),
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
            shownSpinner = {
              handle: spinner(promptOutput()),
              message: currentMessage,
              pauses: 0,
            };
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

          // The spinner clears first, so the opening lines and the outcome never draw over it.
          const settleWith = (nextMessage: string | undefined, emit: (line: string) => void) =>
            finish(() => {
              if (shown) shownSpinner?.handle.clear();
            }).pipe(
              Effect.andThen(
                nextMessage === undefined
                  ? Effect.void
                  : afterOpen(Effect.sync(() => emit(nextMessage))),
              ),
            );

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
              settleWith(nextMessage, (line) => statusLog.success(line)),
            fail: (nextMessage?: string) =>
              settleWith(nextMessage, (line) => statusLog.error(line)),
            info: (nextMessage?: string) => settleWith(nextMessage, (line) => statusLog.info(line)),
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
          yield* openForPrompt;
          const validate = opts?.validate;
          const value = yield* Effect.promise(() =>
            text({
              ...promptOutput(),
              message,
              validate: validate ? (v: string | undefined) => validate(v ?? "") : undefined,
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
          yield* openForPrompt;
          const value = yield* Effect.promise(() => password({ ...promptOutput(), message }));
          if (isCancel(value)) {
            cancel("Operation cancelled.");
            return yield* Effect.interrupt;
          }
          return typeof value === "string" ? value.trim() : "";
        }),
      promptConfirm: (message: string, opts?: { defaultValue?: boolean }) =>
        Effect.gen(function* () {
          yield* openForPrompt;
          const value = yield* Effect.promise(() =>
            confirm({
              ...promptOutput(),
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
      promptSelect: (message, options, behavior) =>
        openForPrompt.pipe(Effect.andThen(promptSelect(message, options, behavior))),
      promptMultiSelect: (message, options) =>
        openForPrompt.pipe(Effect.andThen(promptMultiSelect(message, options))),
      progress: (opts: { max: number }) =>
        afterOpen(
          Effect.sync(() => {
            const bar = clackProgress({ max: opts.max, style: "heavy" });
            return {
              start: (msg: string) => Effect.sync(() => bar.start(msg)),
              advance: (step: number, msg?: string) => Effect.sync(() => bar.advance(step, msg)),
              message: (msg: string) => Effect.sync(() => bar.message(msg)),
              stop: (msg: string) => Effect.sync(() => bar.stop(msg)),
            };
          }),
        ),
      result: () => Effect.void,
      success: (message: string) => logAround(statusLog.success, message),
      fail: (err: {
        code: string;
        message: string;
        detail?: string;
        suggestion?: string;
        entitlement?: PlanGateEntitlement;
      }) =>
        Effect.sync(() => {
          // A command failure is terminal, so a still-shown task spinner is dropped.
          if (activeSpinner !== undefined) {
            activeSpinner.handle.clear();
            activeSpinner.pauses = 0;
            activeSpinner = undefined;
          }
          const debugHint =
            err.suggestion === undefined &&
            err.message !== CONTEXT_CANCELED_MESSAGE &&
            !process.argv.includes("--debug");
          if (process.stderr.isTTY) {
            const headline = readableHttpFailure(err.message);
            process.stderr.write(
              `${leaveDebugRun("\n")}\n${errorBlock({
                message: headline.message,
                detail:
                  [headline.detail, err.detail !== err.message ? err.detail : undefined]
                    .filter((line) => line !== undefined)
                    .join("\n") || undefined,
                suggestion: err.suggestion,
                recovery: debugHint
                  ? { instruction: "See what went wrong", command: rerunWithDebug() }
                  : undefined,
              })}`,
            );
            return;
          }
          // Piped stderr keeps the established plain format.
          process.stderr.write(styleText("red", err.message) + "\n");
          if (err.detail !== undefined && err.detail !== err.message) {
            process.stderr.write(styleText("gray", err.detail) + "\n");
          }
          if (err.suggestion !== undefined) {
            process.stderr.write(err.suggestion + "\n");
          } else if (debugHint) {
            // Withheld for the canceled sentinel: declining a prompt is a
            // user decision, not something to troubleshoot.
            process.stderr.write(
              "Try rerunning the command with --debug to troubleshoot the error.\n",
            );
          }
        }),
      raw: (text: string, stream: "stdout" | "stderr" = "stdout") =>
        withSpinnerPaused(() =>
          open.pipe(
            Effect.andThen(
              write(
                (stream === "stdout" ? tty.stdoutIsTty : process.stderr.isTTY)
                  ? indentLines(asGutterOutcome(stream === "stderr" ? asGutterWarning(text) : text))
                  : text,
                stream,
              ),
            ),
          ),
        ),
      rawBytes: (bytes: Uint8Array, stream: "stdout" | "stderr" = "stdout") =>
        withSpinnerPaused(() => open.pipe(Effect.andThen(write(bytes, stream)))),
    });
  });

/** Text output with no opening lines, for runs that render no command's own output. */
export const textOutputLayer = Layer.effect(Output, makeTextOutput(undefined));

/** Text output that opens with `header` on a terminal. */
export const commandTextOutputLayer = (header: CommandHeader | undefined) =>
  Layer.effect(Output, makeTextOutput(header));

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
    const result = (data: unknown) =>
      withCommandTarget(data).pipe(
        Effect.flatMap((merged) => writeStdout(`${JSON.stringify(merged)}\n`)),
      );

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
      fail: (err: {
        code: string;
        message: string;
        detail?: string;
        suggestion?: string;
        entitlement?: PlanGateEntitlement;
      }) =>
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
      withCommandTarget(data).pipe(
        Effect.flatMap((merged) =>
          emitEvent((timestamp) => ({ type: "result", data: merged, timestamp })),
        ),
      );

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
      fail: (err: {
        code: string;
        message: string;
        detail?: string;
        suggestion?: string;
        entitlement?: PlanGateEntitlement;
      }) =>
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
  header?: CommandHeader,
): Layer.Layer<Output, never, Stdio.Stdio | Tty> {
  switch (format) {
    case "text":
      return header === undefined ? textOutputLayer : commandTextOutputLayer(header);
    case "json":
      return jsonOutputLayer;
    case "stream-json":
      return streamJsonOutputLayer;
  }
}
