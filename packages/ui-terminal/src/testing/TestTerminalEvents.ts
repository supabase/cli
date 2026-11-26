import { Context, Effect, Layer } from "effect";

import type { KeyPayload } from "../Terminal.ts";
import { keyBytes } from "../internal/key-bytes.ts";
import { TestTerminal } from "./TerminalTest.ts";

export interface TestTerminalEvents {
  readonly pressKey: (
    key: string,
    details?: Partial<Omit<KeyPayload, "key">>,
  ) => Effect.Effect<void>;
  /** Resizes the headless terminal and notifies the host, like a window resize. */
  readonly resize: (width: number, height: number) => Effect.Effect<void>;
}

export const TestTerminalEvents: Context.Service<TestTerminalEvents, TestTerminalEvents> =
  Context.Service<TestTerminalEvents>("@supabase/ui-terminal/testing/TestTerminalEvents");

/** The events service over the `TestTerminal` in context. */
export const layer: Layer.Layer<TestTerminalEvents, never, TestTerminal> = Layer.effect(
  TestTerminalEvents,
  Effect.gen(function* () {
    const terminal = yield* TestTerminal;
    return {
      pressKey: (key, details) => terminal.type(keyBytes(key, details)),
      resize: (width, height) => terminal.resize({ columns: width, rows: height }),
    };
  }),
);

/** Types the bytes of `key`. */
export const pressKey = (
  key: string,
  details?: Partial<Omit<KeyPayload, "key">>,
): Effect.Effect<void, never, TestTerminalEvents> =>
  TestTerminalEvents.useSync((events) => events.pressKey(key, details)).pipe(Effect.flatten);

/** Resizes the terminal. */
export const resize = (
  width: number,
  height: number,
): Effect.Effect<void, never, TestTerminalEvents> =>
  TestTerminalEvents.useSync((events) => events.resize(width, height)).pipe(Effect.flatten);
