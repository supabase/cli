import { LogsClipboard } from "./logs.clipboard.ts";
import process from "node:process";
import { Effect, Exit, Option, Queue, Schema, Stream, Terminal } from "effect";
import { Output } from "../../shared/output/output.service.ts";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import {
  appendBrowserRow,
  browserKey,
  initialBrowserState,
  renderBrowser,
  resizeBrowser,
} from "./logs.browser.format.ts";

export interface LogsBrowserSink {
  readonly entry: (row: Schema.JsonObject) => Effect.Effect<void>;
  readonly notice: (message: string) => Effect.Effect<void>;
}

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

type BrowserEvent<E> =
  | { readonly kind: "entry"; readonly row: Schema.JsonObject }
  | { readonly kind: "notice"; readonly message: string }
  | { readonly kind: "key"; readonly input: Terminal.UserInput }
  | { readonly kind: "copied"; readonly message: string }
  | { readonly kind: "resize" }
  | { readonly kind: "closed" }
  | { readonly kind: "complete"; readonly exit: Exit.Exit<void, E> };

const isCopyKey = (key: Terminal.Key) => !key.ctrl && !key.meta && key.name.toLowerCase() === "c";

const encodeClipboardRecord = Schema.encodeEffect(
  Schema.fromJsonString(Schema.JsonObject, { space: 2 }),
);

export const browseLogs = Effect.fn("Logs.browser")(function* <E, R>(
  produce: (sink: LogsBrowserSink) => Effect.Effect<void, E, R>,
  mode: "query" | "tail" = "tail",
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
      yield* produce({
        entry: (row) => Queue.offer(events, { kind: "entry", row }).pipe(Effect.asVoid),
        notice: (message) => Queue.offer(events, { kind: "notice", message }).pipe(Effect.asVoid),
      }).pipe(
        Effect.exit,
        Effect.flatMap((exit) => Queue.offer(events, { kind: "complete", exit })),
        Effect.forkScoped,
      );
      let state = initialBrowserState;
      let copying = false;
      while (true) {
        const columns = yield* terminal.columns;
        const rows = yield* terminal.rows;
        state = resizeBrowser(state, rows);
        yield* terminal.display(
          `\u001b[H\u001b[2J${renderBrowser(state, columns, rows, process.stdout)}`,
        );
        const event = yield* Queue.take(events);
        switch (event.kind) {
          case "entry":
            state = appendBrowserRow(state, event.row, mode);
            break;
          case "notice":
            state = { ...state, notice: event.message };
            break;
          case "copied":
            copying = false;
            state = { ...state, notice: event.message };
            break;
          case "resize":
            break;
          case "closed":
            return;
          case "complete":
            if (Exit.isFailure(event.exit)) return yield* Effect.failCause(event.exit.cause);
            if (state.rows.length === 0) return "empty";
            state = { ...state, complete: true };
            break;
          case "key":
            if (event.input.key.ctrl && event.input.key.name.toLowerCase() === "c") {
              yield* processControl.setExitCode(130);
              return;
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
  ).pipe(
    Effect.flatMap((result) =>
      result === "empty"
        ? Effect.flatMap(Output, (output) => output.raw("No log rows.\n"))
        : Effect.void,
    ),
  );
});
