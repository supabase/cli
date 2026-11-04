import type { LogsSession } from "./logs.session.ts";
import { LogsClipboard } from "./logs.clipboard.ts";
import process from "node:process";
import { Clock, Effect, Exit, Option, Queue, Schema, Stream, Terminal } from "effect";
import { Output } from "../../shared/output/output.service.ts";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import {
  appendBrowserRow,
  applyBrowserBatch,
  stageBrowserRow,
  type BrowserState,
  browserKey,
  initialBrowserState,
  renderBrowser,
  resizeBrowser,
  type LogsBrowserWindow,
} from "./logs.browser.format.ts";

export const useLogsBrowser = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const tty = yield* Effect.serviceOption(Tty);
  return (
    output.format === "text" &&
    output.interactive &&
    Option.isSome(tty) &&
    tty.value.stdinIsTty &&
    tty.value.stdoutIsTty
  );
});

interface LoadedBatch {
  readonly rows: ReadonlyArray<Schema.JsonObject>;
  readonly dropped: number;
  readonly window: LogsBrowserWindow;
}

type BrowserEvent<E> =
  | { readonly kind: "loaded"; readonly result: Exit.Exit<LoadedBatch, E> }
  | { readonly kind: "key"; readonly input: Terminal.UserInput }
  | { readonly kind: "copied"; readonly message: string }
  | { readonly kind: "resize" }
  | { readonly kind: "closed" };

const isCopyKey = (key: Terminal.Key) => !key.ctrl && !key.meta && key.name.toLowerCase() === "c";

const encodeClipboardRecord = Schema.encodeEffect(
  Schema.fromJsonString(Schema.JsonObject, { space: 2 }),
);

export const browseLogs = Effect.fn("Logs.browser")(function* <E>(
  session: LogsSession<E>,
  started: number,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      const processControl = yield* ProcessControl;
      const events = yield* Queue.bounded<BrowserEvent<E>>(64);
      const input = yield* terminal.readInput;
      yield* Effect.acquireRelease(Effect.void, () =>
        terminal.display("\u001b[?25h\u001b[?1049l").pipe(Effect.orDie),
      );
      yield* terminal.display("\u001b[?1049h\u001b[?25l");
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const resize = () => {
            Queue.offerUnsafe(events, { kind: "resize" });
          };
          process.stdout.on("resize", resize);
          return resize;
        }),
        (resize) =>
          Effect.sync(() => {
            process.stdout.off("resize", resize);
          }),
      );
      yield* Stream.fromQueue(input).pipe(
        Stream.runForEach((input) => Queue.offer(events, { kind: "key", input })),
        Effect.andThen(Queue.offer(events, { kind: "closed" })),
        Effect.forkScoped,
      );
      let state = initialBrowserState;
      let copying = false;
      let loading = false;
      const load = Effect.fn("Logs.browser.load")(function* (end: number) {
        if (loading) return;
        loading = true;
        state = {
          ...state,
          complete: false,
          notice:
            state.rows.length === 0
              ? "Loading logs…"
              : session.mode === "replace"
                ? "Rerunning query…"
                : "Loading newer logs…",
        };
        let staged: BrowserState = initialBrowserState;
        yield* session
          .load(end, (row) =>
            Effect.sync(() => {
              staged =
                session.mode === "replace"
                  ? appendBrowserRow(staged, row, "query")
                  : stageBrowserRow(staged, row);
            }),
          )
          .pipe(
            Effect.map((window): LoadedBatch => ({
              rows: staged.rows,
              dropped: staged.dropped,
              window,
            })),
            Effect.exit,
            Effect.flatMap((result) => Queue.offer(events, { kind: "loaded", result })),
            Effect.forkScoped,
          );
      });
      yield* load(started);
      while (true) {
        const columns = yield* terminal.columns;
        const rows = yield* terminal.rows;
        state = resizeBrowser(state, rows);
        yield* terminal.display(
          `\u001b[H\u001b[2J${renderBrowser(state, columns, rows, process.stdout, session.mode)}`,
        );
        const event = yield* Queue.take(events);
        switch (event.kind) {
          case "loaded": {
            loading = false;
            if (Exit.isFailure(event.result)) {
              const error = Exit.findErrorOption(event.result);
              if (Option.isNone(error)) return yield* Effect.failCause(event.result.cause);
              state = {
                ...state,
                complete: true,
                notice: `${error.value instanceof Error ? error.value.message : String(error.value)} Press L to retry.`,
              };
            } else {
              const initial = state.window === undefined;
              state = applyBrowserBatch(state, event.result.value, session.mode);
              state = {
                ...state,
                window: event.result.value.window,
                complete: true,
                notice: initial
                  ? ""
                  : event.result.value.rows.length === 0
                    ? "No newer logs."
                    : session.mode === "replace"
                      ? "Query reloaded."
                      : "Newer logs loaded.",
              };
            }
            break;
          }
          case "copied":
            copying = false;
            state = { ...state, notice: event.message };
            break;
          case "resize":
            break;
          case "closed":
            return;
          case "key":
            if (event.input.key.ctrl && event.input.key.name.toLowerCase() === "c") {
              yield* processControl.setExitCode(130);
              return;
            }
            if (
              !event.input.key.ctrl &&
              !event.input.key.meta &&
              event.input.key.name.toLowerCase() === "l"
            ) {
              yield* load(yield* Clock.currentTimeMillis);
              break;
            }
            if (isCopyKey(event.input.key)) {
              const row = state.detail ?? state.rows[state.selected];
              if (row === undefined || copying) break;
              const clipboard = yield* LogsClipboard;
              copying = true;
              state = { ...state, notice: "Copying log…" };
              const text = yield* encodeClipboardRecord(row).pipe(Effect.orDie);
              yield* clipboard.copy(text).pipe(
                Effect.match({
                  onSuccess: () => "Copied log to clipboard.",
                  onFailure: (error) => error.message,
                }),
                Effect.flatMap((message) => Queue.offer(events, { kind: "copied", message })),
                Effect.forkScoped,
              );
              break;
            }
            if (
              event.input.key.name === "q" ||
              (event.input.key.ctrl && event.input.key.name === "d")
            )
              return;
            state = browserKey(state, event.input.key.name, Math.max(2, columns - 1), rows);
        }
      }
    }),
  );
});
