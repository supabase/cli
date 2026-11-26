import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import xterm from "@xterm/headless";
import type { Component } from "@effect/ui";
import type * as Renderer from "@effect/ui/Renderer";
import { Context, Deferred, Effect, Exit, Layer } from "effect";
import type { Fiber, Scope } from "effect";

import type { Env, Size } from "../internal/capabilities.ts";
import * as Transport from "../internal/transport.ts";
import type * as Terminal from "../Terminal.ts";
import * as TerminalHost from "../TerminalHost.ts";
import { keyBytes } from "../internal/key-bytes.ts";

export interface TestOptions {
  readonly columns: number;
  readonly rows: number;
  /** Environment the terminal's capabilities are detected from; defaults to a 256-color `TERM`. */
  readonly env?: Env | undefined;
}

/** A terminal backed by `@xterm/headless` that runs the production decoder and writer. */
export interface TestTerminal {
  readonly terminal: Transport.Interface;
  /** Visible rows, trimmed on the right, once every write has reached the emulator. */
  readonly screenText: Effect.Effect<ReadonlyArray<string>>;
  /** Every byte the host has written, once the emulator has received it. */
  readonly output: Effect.Effect<string>;
  /** Every buffer line, scrolled-off rows first, trimmed on the right. */
  readonly scrollback: Effect.Effect<ReadonlyArray<string>>;
  readonly cursor: Effect.Effect<{ readonly x: number; readonly y: number }>;
  /** Injects bytes as stdin `data` events. */
  readonly type: (bytes: string) => Effect.Effect<void>;
  readonly resize: (size: Size) => Effect.Effect<void>;
  /** Every `setRawMode` call made on stdin, in order. */
  readonly rawModeTransitions: Effect.Effect<ReadonlyArray<boolean>>;
  /** How many stdin `data` and output `resize` listeners are attached right now. */
  readonly listeners: Effect.Effect<{ readonly data: number; readonly resize: number }>;
  /** Completes when `predicate` holds for the visible screen, re-checking after each write. */
  readonly untilScreen: (
    predicate: (rows: ReadonlyArray<string>) => boolean,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly dispose: () => void;
}

const encoder = new TextEncoder();

export const makeTestTerminal = (options: TestOptions): TestTerminal => {
  const emulator = new xterm.Terminal({
    cols: options.columns,
    rows: options.rows,
    allowProposedApi: true,
  });
  emulator.loadAddon(new UnicodeGraphemesAddon());
  emulator.unicode.activeVersion = "15-graphemes";

  const dataListeners = new Set<(chunk: Uint8Array | string) => void>();
  const resizeListeners = new Set<() => void>();
  const rawModeTransitions: Array<boolean> = [];
  const size = { columns: options.columns, rows: options.rows };
  const input: { flowing: boolean | null; raw: boolean } = { flowing: null, raw: false };

  // The emulator parses asynchronously; chaining its callbacks gives "everything written so far".
  let written: Promise<void> = Promise.resolve();
  let output = "";
  const writeObservers = new Set<() => void>();

  const terminal = Transport.make({
    input: {
      isTTY: true,
      get isRaw() {
        return input.raw;
      },
      get readableFlowing() {
        return input.flowing;
      },
      setRawMode: (mode) => {
        rawModeTransitions.push(mode);
        input.raw = mode;
      },
      resume: () => {
        input.flowing = true;
      },
      pause: () => {
        input.flowing = false;
      },
      on: (_event, listener) => {
        dataListeners.add(listener);
      },
      off: (_event, listener) => {
        dataListeners.delete(listener);
      },
    },
    output: {
      isTTY: true,
      get columns() {
        return size.columns;
      },
      get rows() {
        return size.rows;
      },
      write: (chunk) => {
        output += chunk;
        written = written.then(() => {
          const parsed = Promise.withResolvers<void>();
          emulator.write(chunk, () => {
            parsed.resolve();
            for (const observer of writeObservers) observer();
          });
          return parsed.promise;
        });
      },
      on: (event, listener) => {
        if (event === "resize") resizeListeners.add(listener);
      },
      off: (event, listener) => {
        if (event === "resize") resizeListeners.delete(listener);
      },
    },
    env: options.env ?? { TERM: "xterm-256color" },
    platform: "linux",
  });

  const settled = Effect.promise(() => written);
  const line = (index: number) =>
    emulator.buffer.active.getLine(index)?.translateToString(true) ?? "";
  const visible = () =>
    Array.from({ length: emulator.rows }, (_, row) => line(emulator.buffer.active.viewportY + row));

  return {
    terminal,
    screenText: settled.pipe(Effect.map(visible)),
    output: settled.pipe(Effect.map(() => output)),
    scrollback: settled.pipe(
      Effect.map(() =>
        Array.from({ length: emulator.buffer.active.length }, (_, index) => line(index)),
      ),
    ),
    cursor: settled.pipe(
      Effect.map(() => ({ x: emulator.buffer.active.cursorX, y: emulator.buffer.active.cursorY })),
    ),
    type: (bytes) =>
      Effect.sync(() => {
        const chunk = encoder.encode(bytes);
        for (const listener of dataListeners) listener(chunk);
      }),
    resize: (next) =>
      Effect.sync(() => {
        emulator.resize(next.columns, next.rows);
        size.columns = next.columns;
        size.rows = next.rows;
        for (const listener of resizeListeners) listener();
      }),
    rawModeTransitions: Effect.sync(() => [...rawModeTransitions]),
    listeners: Effect.sync(() => ({ data: dataListeners.size, resize: resizeListeners.size })),
    untilScreen: (predicate) =>
      Effect.gen(function* () {
        for (;;) {
          // Subscribe before checking, so a write landing between the two still wakes the wait.
          const wake = Deferred.makeUnsafe<void>();
          const observer = () => Deferred.doneUnsafe(wake, Exit.void);
          writeObservers.add(observer);
          const rows = yield* settled.pipe(Effect.map(visible));
          if (predicate(rows)) {
            writeObservers.delete(observer);
            return rows;
          }
          yield* Deferred.await(wake).pipe(
            Effect.ensuring(Effect.sync(() => writeObservers.delete(observer))),
          );
        }
      }),
    dispose: () => emulator.dispose(),
  };
};

/** Runs `body` against a fresh headless terminal and disposes the emulator afterwards. */
export const withTestTerminal = <A, E = never>(
  options: TestOptions,
  body: (terminal: TestTerminal) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeTestTerminal(options)),
    body,
    (terminal) => Effect.sync(terminal.dispose),
  );

/** Forks `program` against the test terminal, so the test can drive it while it runs. */
export const startOn = <A, E>(
  test: TestTerminal,
  program: Effect.Effect<A, E, Transport.Service>,
): Effect.Effect<Fiber.Fiber<A, E>> =>
  Effect.forkChild(program.pipe(Effect.provideService(Transport.Service, test.terminal)));

/** The headless terminal a test layer or mount created; the same handle `startOn` and `withTestTerminal` give. */
export const TestTerminal: Context.Service<TestTerminal, TestTerminal> =
  Context.Service<TestTerminal>("@supabase/ui-terminal/testing/TerminalTest/TestTerminal");

const acquire = (options: Partial<TestOptions> | undefined) =>
  Effect.acquireRelease(
    Effect.sync(() => makeTestTerminal({ columns: 80, rows: 24, ...options })),
    (terminal) => Effect.sync(terminal.dispose),
  );

/** A headless terminal as the transport, so `TerminalHost.run` and `layer` draw into it; the handle is provided too. */
export const layer = (
  options?: Partial<TestOptions>,
): Layer.Layer<TerminalHost.Transport | TestTerminal> =>
  Layer.unwrap(
    Effect.map(acquire(options), (terminal) =>
      Layer.mergeAll(
        Layer.succeed(TerminalHost.Transport, terminal.terminal),
        Layer.succeed(TestTerminal, terminal),
      ),
    ),
  );

/** A component mounted on a headless terminal, with the handle to drive and read it. */
export interface MountedApp<out Model, in Msg> extends TerminalHost.Mounted<Model, Msg> {
  readonly terminal: TestTerminal;
  /** Types the bytes a terminal sends for `key`, using `TerminalKeyboard`'s key names. */
  readonly pressKey: (key: string, modifiers?: Modifiers) => Effect.Effect<void>;
}

type Modifiers = Parameters<typeof keyBytes>[1];

/** Mounts `component` on a headless terminal for the life of the scope and returns the handle to drive it. */
export const mount = <Name extends string, Props, Model, Msg, Events, R, RP = never>(
  component: Component.Members<Name, Props, Model, Msg, Events, R, Terminal.Elements>,
  props: Props | Effect.Effect<Props, never, RP>,
  options?: Partial<TestOptions>,
): Effect.Effect<
  MountedApp<Model, Msg>,
  never,
  Exclude<R | RP, Terminal.Host | Renderer.Renderer> | Scope.Scope
> =>
  Effect.gen(function* () {
    const terminal = yield* acquire(options);
    const mounted = yield* TerminalHost.mountEffect(component, props).pipe(
      Effect.provideService(TerminalHost.Transport, terminal.terminal),
      Effect.orDie,
    );
    return {
      ...mounted,
      terminal,
      pressKey: (key, modifiers) => terminal.type(keyBytes(key, modifiers)),
    };
  });
