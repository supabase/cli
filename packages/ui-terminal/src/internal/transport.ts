import { Config, Context, Effect, FiberHandle, Layer, Option, Schema } from "effect";
import type { Scope } from "effect";

import { detectCapabilities } from "./capabilities.ts";
import type { Capabilities, CapabilityFacts, Env, Size } from "./capabilities.ts";
import * as Decoder from "./decoder.ts";
import type { Key } from "./key.ts";

/** A run needs a terminal on both ends: stdin and stdout TTYs and a `TERM` that is not `dumb`. */
export class NonInteractive extends Schema.TaggedError<NonInteractive>()("NonInteractive", {
  reason: Schema.Literals(["stdin-not-tty", "stdout-not-tty", "dumb-terminal"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "stdin-not-tty":
        return "This command needs an interactive terminal: stdin is not a TTY";
      case "stdout-not-tty":
        return "This command needs an interactive terminal: stdout is not a TTY";
      case "dumb-terminal":
        return "This command needs an interactive terminal: TERM is dumb";
    }
  }
}

/** The slice of a readable TTY stream the terminal drives; `process.stdin` satisfies it. */
interface InputStream {
  readonly isTTY?: boolean | undefined;
  readonly isRaw?: boolean | undefined;
  /** Node's flow state: `true` when something already consumes the stream. */
  readonly readableFlowing?: boolean | null | undefined;
  readonly setRawMode?: ((mode: boolean) => unknown) | undefined;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  off(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
}

/** The slice of a writable TTY stream the terminal drives; `process.stdout` satisfies it. */
export interface OutputStream {
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  write(chunk: string): unknown;
  on(event: "resize" | "error", listener: () => void): unknown;
  off(event: "resize" | "error", listener: () => void): unknown;
}

/** Decoded key presses, delivered synchronously to each listener. */
interface KeyEvents {
  readonly listen: (listener: (key: Key) => void) => () => void;
}

/** What a run needs from the terminal. */
export interface Interface {
  readonly capabilities: Capabilities;
  /** Hands the bytes to the output stream; a failed write surfaces as an `error` event, which is ignored. */
  readonly write: (bytes: string) => void;
  /** Current terminal size, falling back to `COLUMNS`/`LINES` and then 80x24. */
  readonly size: () => Size;
  /** Calls `listener` on every resize until the returned function is called. */
  readonly onResize: (listener: () => void) => () => void;
  /** Puts stdin in raw mode and decodes it until the scope closes; closing restores stdin. */
  readonly keys: Effect.Effect<KeyEvents, never, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@supabase/ui-terminal/Transport",
) {}

/** The structural streams `make` drives, with the environment and platform to detect from. */
export interface Streams {
  readonly input: InputStream;
  readonly output: OutputStream;
  readonly env: Env;
  readonly platform?: string | undefined;
}

const escapeTimeout = "50 millis";
const encoder = new TextEncoder();

/** Builds the service over structural streams; `layerProcess` and the test layer share it. */
export const make = ({ input, output, env, platform }: Streams): Interface => {
  const facts = (): CapabilityFacts => ({
    env,
    platform,
    output: { isTTY: output.isTTY === true, columns: output.columns, rows: output.rows },
    input: { isTTY: input.isTTY === true },
  });

  const keys = Effect.gen(function* () {
    const listeners = new Set<(key: Key) => void>();
    const runTimer = yield* FiberHandle.makeRuntime<never>();
    let decoder = Decoder.initialState;
    let generation = 0;

    const publish = (decoded: ReadonlyArray<Key>) => {
      for (const key of decoded) for (const listener of Array.from(listeners)) listener(key);
    };
    const onData = (chunk: Uint8Array | string) => {
      const result = Decoder.feed(
        decoder,
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      );
      decoder = result.state;
      publish(result.keys);
      const armed = ++generation;
      if (!Decoder.hasPendingEscape(decoder)) return;
      runTimer(
        Effect.sleep(escapeTimeout).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (generation !== armed) return;
              const flushed = Decoder.flushEscape(decoder);
              decoder = flushed.state;
              publish(flushed.keys);
            }),
          ),
        ),
      );
    };

    const priorRaw = input.isRaw === true;
    // Attaching a `data` listener starts the flow, so this has to be read first.
    const wasFlowing = input.readableFlowing === true;
    // Each release step guards its own failure so a hung-up terminal cannot skip the rest.
    const step = (run: () => unknown) => Effect.try(run).pipe(Effect.ignore);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        input.setRawMode?.(true);
        input.on("data", onData);
        input.resume();
      }),
      () =>
        Effect.gen(function* () {
          generation++;
          yield* step(() => input.off("data", onData));
          if (!wasFlowing) yield* step(() => input.pause());
          yield* step(() => input.setRawMode?.(priorRaw));
        }).pipe(Effect.withSpan("Terminal.restoreInput")),
    );

    return {
      listen: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } satisfies KeyEvents;
  }).pipe(Effect.withSpan("Terminal.acquireInput"));

  return {
    capabilities: detectCapabilities(facts()),
    write: (bytes) => {
      output.write(bytes);
    },
    size: () => {
      const { columns, rows } = detectCapabilities(facts()).output;
      return { columns, rows };
    },
    onResize: (listener) => {
      output.on("resize", listener);
      return () => {
        output.off("resize", listener);
      };
    },
    keys,
  };
};

const envKeys: ReadonlyArray<string> = [
  "NO_COLOR",
  "FORCE_COLOR",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "WT_SESSION",
  "COLUMNS",
  "LINES",
];

/** Reads the capability-relevant variables through the active `ConfigProvider`; an unset or empty one is absent. */
const readEnv = Effect.forEach(envKeys, (key) =>
  Config.option(Config.String(key)).pipe(
    Effect.map((value): [string, string | undefined] => [key, Option.getOrUndefined(value)]),
  ),
).pipe(
  Effect.map((entries) => Object.fromEntries(entries)),
  Effect.orDie,
);

const guardedOutputs = new WeakSet<OutputStream>();
const ignoreStreamError = () => {};

/** A failed write emits `error` after its call returns; unhandled, that event crashes the process. */
const guardOutput = (output: OutputStream) => {
  if (guardedOutputs.has(output)) return;
  guardedOutputs.add(output);
  output.on("error", ignoreStreamError);
};

/** The process terminal on Node or Bun: `process.stdin` and `process.stdout`, with the environment read once through `Config`. */
export const layerProcess = Layer.effect(
  Service,
  Effect.gen(function* () {
    const env = yield* readEnv;
    const output = process.stdout;
    yield* Effect.sync(() => guardOutput(output));
    return Service.of(make({ input: process.stdin, output, env, platform: process.platform }));
  }),
);
