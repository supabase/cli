import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";

import type { Capabilities, Size } from "../capabilities.ts";
import { detectCapabilities, type CapabilityFacts, type Env } from "./detect-capabilities.ts";
import { openInputSession, type InputSession, type InputStream } from "./input-session.ts";

/**
 * `write`: a write failed, for example with `EPIPE` when the reader went away. `busy`: another run
 * already owns the terminal's input.
 */
export class TerminalError extends Schema.TaggedError<TerminalError>()("TerminalError", {
  reason: Schema.Literals(["write", "busy"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "busy"
      ? "The terminal is already in use by another run"
      : "Terminal write failed";
  }
}

/** The slice of a writable TTY stream the terminal drives; `process.stdout` satisfies it. */
export interface OutputStream {
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  write(chunk: string, callback: (error?: Error | null) => void): unknown;
  on(event: "resize" | "error", listener: () => void): unknown;
  off(event: "resize" | "error", listener: () => void): unknown;
}

/** The current size and the smallest one seen since the previous sample. */
export interface Geometry {
  readonly current: Size;
  readonly smallest: Size;
}

/** What a run needs from the terminal: capabilities, writes, size, resizes, input and the claim. */
export interface Interface {
  readonly capabilities: Capabilities;
  /** Completes once the stream has accepted the bytes. */
  readonly write: (bytes: string) => Effect.Effect<void, TerminalError>;
  /** Current terminal size, falling back to `COLUMNS`/`LINES` and then 80x24. */
  readonly size: Effect.Effect<Size>;
  /** Reads the geometry and restarts the minimum from it; resizes are recorded as they happen. */
  readonly sampleGeometry: Effect.Effect<Geometry>;
  readonly resizes: Stream.Stream<Size>;
  /** Opens this run's input session; closing the scope closes the session. */
  readonly openInput: Effect.Effect<InputSession, never, Scope.Scope>;
  /**
   * Claims the input stream until the scope closes, failing at once with reason `busy` when it is
   * already claimed; every terminal built over the same stream shares the claim.
   */
  readonly claim: Effect.Effect<void, TerminalError, Scope.Scope>;
}

/** The terminal service a run reads; provide `layerProcess` or a test layer. */
export class Service extends Context.Service<Service, Interface>()("@supabase/tui/Terminal") {}

/** The structural streams `make` drives, with the environment and platform to detect from. */
export interface Streams {
  readonly input: InputStream;
  readonly output: OutputStream;
  readonly env: Env;
  readonly platform?: string | undefined;
}

const claimedInputs = new WeakSet<InputStream>();
const guardedOutputs = new WeakSet<OutputStream>();
const ignoreStreamError = () => {};

/**
 * A failed write also emits `error` on the stream, after its callback and possibly after the
 * layer is gone; unhandled, that event crashes the process, so the listener is never removed.
 */
const guardOutput = (output: OutputStream) => {
  if (guardedOutputs.has(output)) return;
  guardedOutputs.add(output);
  output.on("error", ignoreStreamError);
};

/**
 * Builds the service over structural streams; `layerProcess` and the test layer share it. The streams
 * outlive the service, so a caller that supplies Node writable streams owns their `error` listener
 * policy: a failed write also emits `error`, which crashes the process when nobody listens.
 */
export const make = Effect.fn("Terminal.make")(function* (streams: Streams) {
  const { input, output, env, platform } = streams;
  const facts = (): CapabilityFacts => ({
    env,
    platform,
    output: { isTTY: output.isTTY === true, columns: output.columns, rows: output.rows },
    input: { isTTY: input.isTTY === true },
  });
  const currentSize = (): Size => {
    const { columns, rows } = detectCapabilities(facts()).output;
    return { columns, rows };
  };

  const write = Effect.fn("Terminal.write")(function* (bytes: string) {
    yield* Effect.annotateCurrentSpan("bytes", bytes.length);
    yield* Effect.callback<void, TerminalError>((resume) => {
      const fail = (cause: unknown) =>
        resume(Effect.fail(new TerminalError({ reason: "write", cause })));
      try {
        output.write(bytes, (error) => (error == null ? resume(Effect.void) : fail(error)));
      } catch (cause) {
        fail(cause);
      }
    });
  });

  let smallest = currentSize();
  const smallerOf = (a: Size, b: Size): Size => ({
    columns: Math.min(a.columns, b.columns),
    rows: Math.min(a.rows, b.rows),
  });
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const onResize = () => {
        smallest = smallerOf(smallest, currentSize());
      };
      output.on("resize", onResize);
      return onResize;
    }),
    (onResize) => Effect.sync(() => output.off("resize", onResize)),
  );
  const sampleGeometry = Effect.sync((): Geometry => {
    const current = currentSize();
    const lowest = smallerOf(smallest, current);
    smallest = current;
    return { current, smallest: lowest };
  });

  const resizes = Stream.callback<Size>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onResize = () => {
          Queue.offerUnsafe(queue, currentSize());
        };
        output.on("resize", onResize);
        return onResize;
      }),
      (onResize) => Effect.sync(() => output.off("resize", onResize)),
    ),
  );

  const claim = Effect.acquireRelease(
    Effect.suspend(() => {
      if (claimedInputs.has(input)) return Effect.fail(new TerminalError({ reason: "busy" }));
      claimedInputs.add(input);
      return Effect.void;
    }),
    () => Effect.sync(() => claimedInputs.delete(input)),
  ).pipe(Effect.asVoid);

  return Service.of({
    capabilities: detectCapabilities(facts()),
    write,
    size: Effect.sync(currentSize),
    sampleGeometry,
    resizes,
    openInput: Effect.suspend(() => openInputSession(input)),
    claim,
  });
});

const envKeys = [
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
] as const;

const processEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/** Reads the capability-relevant variables; an empty `FORCE_COLOR` is a value, not a gap. */
const readEnv = Effect.suspend(() =>
  Effect.forEach(envKeys, (key) =>
    Config.option(Config.String(key)).pipe(
      Effect.map((value) => [key, Option.getOrUndefined(value)] as const),
    ),
  ).pipe(
    Effect.map((entries) => Object.fromEntries(entries)),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: processEnv(), preserveEmptyStrings: true }),
      ),
    ),
  ),
).pipe(Effect.orDie);

/** The process terminal on Node or Bun: `process.stdin` and the chosen output stream, env read once at construction. */
export const layerProcess = (options?: { readonly output?: "stdout" | "stderr" }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const env = yield* readEnv;
      const output = process[options?.output ?? "stdout"];
      yield* Effect.sync(() => guardOutput(output));
      return yield* make({
        input: process.stdin,
        output,
        env,
        platform: process.platform,
      });
    }),
  );
