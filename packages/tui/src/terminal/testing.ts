import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import xterm from "@xterm/headless";
import { Context, Deferred, Effect, Exit, Layer } from "effect";

import type { Size } from "../capabilities.ts";
import type { Env } from "./detect-capabilities.ts";
import type { InputStream } from "./input-session.ts";
import * as Terminal from "./terminal.ts";

/** Writes the output stream is holding, uncompleted, until the test lets them go or fails them. */
export interface WriteStall {
  /** Resolves once the stall has captured a write. */
  readonly captured: Effect.Effect<void>;
  readonly release: Effect.Effect<void>;
  readonly fail: (error: Error) => Effect.Effect<void>;
}

export interface TestTerminalInterface {
  /** Visible rows, trimmed on the right. */
  readonly screenText: Effect.Effect<ReadonlyArray<string>>;
  /** Every buffer line, scrolled-off rows first then the visible screen, trimmed on the right. */
  readonly scrollback: Effect.Effect<ReadonlyArray<string>>;
  readonly cursor: Effect.Effect<{ readonly x: number; readonly y: number }>;
  /** Bytes the output stream has accepted; writes held by `stallWrites` appear on release. */
  readonly rawBytes: Effect.Effect<string>;
  /** Injects bytes as stdin `data` events, below the shared decoder. */
  readonly type: (bytes: string | Uint8Array) => Effect.Effect<void>;
  /** Ends stdin. */
  readonly end: Effect.Effect<void>;
  /** Resizes the emulator, updates the reported size and notifies `resizes`. */
  readonly resize: (size: Size) => Effect.Effect<void>;
  /** Every `setRawMode` call made on stdin, in order. */
  readonly rawModeTransitions: Effect.Effect<ReadonlyArray<boolean>>;
  readonly inputState: Effect.Effect<{
    readonly paused: boolean;
    readonly raw: boolean;
    readonly listenerCount: number;
  }>;
  /** Holds later writes until `release` drains them in order or `fail` rejects them. */
  readonly stallWrites: Effect.Effect<WriteStall>;
  /** Like `stallWrites`, but holds only the next write; the ones after it complete as usual. */
  readonly stallNextWrite: Effect.Effect<WriteStall>;
  /** Makes later writes complete with `error`, as a broken pipe would. */
  readonly failWrites: (error: Error) => Effect.Effect<void>;
}

export class TestTerminal extends Context.Service<TestTerminal, TestTerminalInterface>()(
  "@supabase/tui/TestTerminal",
) {}

export interface TestTerminalOptions {
  readonly columns: number;
  readonly rows: number;
  /** Output is a TTY; defaults to true. */
  readonly isTTY?: boolean;
  /** Input is a TTY; defaults to true. */
  readonly inputIsTTY?: boolean;
  /** Stdin ended before anyone attached, as when the host already drained piped input; defaults to false. */
  readonly inputEnded?: boolean;
  /** The host already consumes stdin when the run starts; otherwise it is a fresh, never-read stream. */
  readonly inputFlowing?: boolean;
  /** Environment seen by capability detection; defaults to `{ TERM: "xterm-256color" }`. */
  readonly env?: Env;
}

const encoder = new TextEncoder();

const makeFake = (options: TestTerminalOptions) => {
  const emulator = new xterm.Terminal({
    cols: options.columns,
    rows: options.rows,
    allowProposedApi: true,
  });
  emulator.loadAddon(new UnicodeGraphemesAddon());
  emulator.unicode.activeVersion = "15-graphemes";

  const inputIsTTY = options.inputIsTTY ?? true;
  const inputListeners = {
    data: new Set<(chunk: Uint8Array | string) => void>(),
    end: new Set<(chunk: Uint8Array | string) => void>(),
    error: new Set<(chunk: Uint8Array | string) => void>(),
  };
  const rawModeTransitions: Array<boolean> = [];
  // Node's tri-state: a fresh stream is `null` until something reads it or pauses it explicitly.
  const inputState: { flowing: boolean | null; raw: boolean; ended: boolean } = {
    flowing: options.inputFlowing === true ? true : null,
    raw: false,
    ended: options.inputEnded ?? false,
  };

  const input: InputStream = {
    isTTY: inputIsTTY,
    get readableEnded() {
      return inputState.ended;
    },
    get readableFlowing() {
      return inputState.flowing;
    },
    get isRaw() {
      return inputState.raw;
    },
    setRawMode: inputIsTTY
      ? (mode: boolean) => {
          rawModeTransitions.push(mode);
          inputState.raw = mode;
        }
      : undefined,
    resume: () => {
      inputState.flowing = true;
    },
    pause: () => {
      inputState.flowing = false;
    },
    on(event, listener) {
      inputListeners[event].add(listener);
      if (event === "data" && inputState.flowing !== false) inputState.flowing = true;
    },
    off(event, listener) {
      inputListeners[event].delete(listener);
    },
  };

  const resizeListeners = new Set<() => void>();
  // The host's permanent `error` policy, as `layerProcess` installs on the process streams.
  const outputErrorListeners = new Set<() => void>([() => {}]);
  const outputSize = { columns: options.columns, rows: options.rows };
  const accepted: Array<string> = [];
  const held: Array<{ readonly drain: () => void; readonly reject: (error: Error) => void }> = [];
  let holding = 0;
  let captured: Deferred.Deferred<void> | undefined;
  let failure: Error | undefined;

  const drain = (chunk: string, done: (error?: Error | null) => void) => {
    accepted.push(chunk);
    emulator.write(chunk, () => done(null));
  };

  const reject = (error: Error, callback: (error?: Error | null) => void) =>
    queueMicrotask(() => {
      callback(error);
      for (const listener of outputErrorListeners) listener();
    });

  const output: Terminal.OutputStream = {
    isTTY: options.isTTY ?? true,
    get columns() {
      return outputSize.columns;
    },
    get rows() {
      return outputSize.rows;
    },
    write(chunk, callback) {
      if (failure !== undefined) {
        reject(failure, callback);
        return false;
      }
      if (holding > 0) {
        holding--;
        held.push({
          drain: () => drain(chunk, callback),
          reject: (error) => reject(error, callback),
        });
        if (captured !== undefined) Deferred.doneUnsafe(captured, Exit.void);
        return false;
      }
      drain(chunk, callback);
      return true;
    },
    on(event, listener) {
      (event === "resize" ? resizeListeners : outputErrorListeners).add(listener);
    },
    off(event, listener) {
      (event === "resize" ? resizeListeners : outputErrorListeners).delete(listener);
    },
  };

  const line = (index: number) =>
    emulator.buffer.active.getLine(index)?.translateToString(true) ?? "";

  const stall = (writes: number): WriteStall => {
    holding = writes;
    const latch = Deferred.makeUnsafe<void>();
    captured = latch;
    const stop = () => {
      holding = 0;
      return held.splice(0);
    };
    return {
      captured: Deferred.await(latch),
      release: Effect.sync(() => {
        for (const write of stop()) write.drain();
      }),
      fail: (error) =>
        Effect.sync(() => {
          for (const write of stop()) write.reject(error);
        }),
    };
  };

  const controls: TestTerminalInterface = {
    screenText: Effect.sync(() =>
      Array.from({ length: emulator.rows }, (_, row) =>
        line(emulator.buffer.active.viewportY + row),
      ),
    ),
    scrollback: Effect.sync(() =>
      Array.from({ length: emulator.buffer.active.length }, (_, index) => line(index)),
    ),
    cursor: Effect.sync(() => ({
      x: emulator.buffer.active.cursorX,
      y: emulator.buffer.active.cursorY,
    })),
    rawBytes: Effect.sync(() => accepted.join("")),
    type: (bytes) =>
      Effect.sync(() => {
        const chunk = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
        for (const listener of inputListeners.data) listener(chunk);
      }),
    end: Effect.sync(() => {
      inputState.ended = true;
      for (const listener of inputListeners.end) listener("");
    }),
    resize: (size) =>
      Effect.sync(() => {
        emulator.resize(size.columns, size.rows);
        outputSize.columns = size.columns;
        outputSize.rows = size.rows;
        for (const listener of resizeListeners) listener();
      }),
    rawModeTransitions: Effect.sync(() => [...rawModeTransitions]),
    inputState: Effect.sync(() => ({
      paused: inputState.flowing !== true,
      raw: inputState.raw,
      listenerCount: inputListeners.data.size + inputListeners.end.size + inputListeners.error.size,
    })),
    stallWrites: Effect.sync(() => stall(Infinity)),
    stallNextWrite: Effect.sync(() => stall(1)),
    failWrites: (error) =>
      Effect.sync(() => {
        failure = error;
      }),
  };

  return { input, output, controls, dispose: () => emulator.dispose() };
};

/** A terminal backed by `@xterm/headless`, running the production session, decoder and write code. */
export const layerTest = (options: TestTerminalOptions) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const fake = yield* Effect.acquireRelease(
        Effect.sync(() => makeFake(options)),
        (f) => Effect.sync(f.dispose),
      );
      const terminal = yield* Terminal.make({
        input: fake.input,
        output: fake.output,
        env: options.env ?? { TERM: "xterm-256color" },
        platform: "linux",
      });
      return Context.make(Terminal.Service, terminal).pipe(
        Context.add(TestTerminal, TestTerminal.of(fake.controls)),
      );
    }),
  );
