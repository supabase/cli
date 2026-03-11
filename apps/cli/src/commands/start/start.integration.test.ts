import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import type { StackInfo } from "@supabase/stack/internals";
import { start } from "./start.handler.ts";
import { startForegroundWithStopSignal } from "./flows/foreground.flow.ts";
import { emptyEnv, mockInk, mockOutput, mockStack } from "../../../tests/helpers/mocks.ts";

const foregroundFlags = { exclude: [], detach: false };
const backgroundFlags = { exclude: [], detach: true };

function setupInteractive(
  opts: {
    info?: Partial<StackInfo>;
    startError?: unknown;
    startPending?: boolean;
    manualExit?: boolean;
  } = {},
) {
  const stack = mockStack({
    info: opts.info,
    startError: opts.startError,
    startPending: opts.startPending,
  });
  const out = mockOutput({ format: "text", interactive: true });
  const ink = mockInk({ manualExit: opts.manualExit });
  const layer = Layer.mergeAll(emptyEnv(), stack.layer, out.layer, ink.layer);
  return { layer, stack, out, ink };
}

function setupNonInteractive(
  opts: {
    info?: Partial<StackInfo>;
    stateChanges?: Array<{ name: string; status: string }>;
  } = {},
) {
  const stack = mockStack({ info: opts.info, stateChanges: opts.stateChanges });
  const out = mockOutput({ format: "text", interactive: false });
  const ink = mockInk();
  const layer = Layer.mergeAll(emptyEnv(), stack.layer, out.layer, ink.layer);
  return { layer, stack, out, ink };
}

const waitFor = Effect.fnUntraced(function* (
  condition: () => boolean,
  message: string,
  attempts = 50,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) {
      return;
    }
    yield* Effect.sleep("1 millis");
  }
  throw new Error(message);
});

describe("start", () => {
  it.live("runs detached mode in the background and prints connection info", () => {
    const { layer, stack, out, ink } = setupNonInteractive();
    return Effect.gen(function* () {
      yield* start(backgroundFlags);

      expect(stack.started).toBe(true);
      expect(ink.rendered).toBe(false);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Local Supabase started" }),
      );

      const infoMessages = out.messages.filter((message) => message.type === "info");
      expect(infoMessages).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("API URL:") }),
      );
      expect(infoMessages).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("DB URL:") }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("runs foreground mode with Ink and disposes the stack on exit", () => {
    const { layer, stack, ink } = setupInteractive({ startPending: true, manualExit: true });
    return Effect.gen(function* () {
      const fiber = yield* start(foregroundFlags).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* waitFor(() => ink.rendered, "dashboard did not render");
      stack.resolveStart();
      ink.exit();
      yield* Fiber.join(fiber);

      expect(stack.started).toBe(true);
      expect(stack.stopped).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("propagates foreground startup failures", () => {
    const { layer, stack } = setupInteractive({ startError: new Error("startup failed") });
    return Effect.gen(function* () {
      const exit = yield* start(foregroundFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(stack.started).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("runs non-interactive mode and streams service state updates", () => {
    const { layer, stack, out, ink } = setupNonInteractive({
      stateChanges: [{ name: "postgres", status: "Healthy" }],
    });
    return Effect.gen(function* () {
      yield* start(foregroundFlags);

      expect(ink.rendered).toBe(false);
      expect(stack.started).toBe(true);
      expect(stack.stopped).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: "postgres: Healthy" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("treats a stop signal as a successful foreground exit", () => {
    const { layer, stack, ink } = setupInteractive({ manualExit: true });
    return Effect.gen(function* () {
      const stopRequested = yield* Deferred.make<void>();
      const fiber = yield* startForegroundWithStopSignal(Deferred.await(stopRequested)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* waitFor(() => ink.rendered, "dashboard did not render");
      yield* Deferred.succeed(stopRequested, void 0);

      const exit = yield* Fiber.await(fiber);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(stack.stopped).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
