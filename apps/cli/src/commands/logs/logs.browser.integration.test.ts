import process from "node:process";
import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Terminal } from "effect";
import { mockOutput, mockProcessControl } from "../../../tests/helpers/mocks.ts";
import { LogsClipboard } from "./logs.clipboard.ts";
import { LogsInputError } from "./logs.errors.ts";
import { browseLogs } from "./logs.browser.ts";
import type { LogsSession } from "./logs.session.ts";

const key = (name: string, ctrl = false): Terminal.UserInput => ({
  input: Option.none(),
  key: { name, ctrl, meta: false, shift: false },
});
const window = {
  kind: "range",
  start: "2026-11-04T10:00:00Z",
  end: "2026-11-04T11:00:00Z",
} satisfies import("./logs.browser.format.ts").LogsBrowserWindow;
const setup = Effect.fnUntraced(function* <E>(session: LogsSession<E>) {
  const input = yield* Queue.unbounded<Terminal.UserInput>();
  const frames = yield* Queue.unbounded<string>();
  const control = mockProcessControl();
  let columns = 80;
  let rows = 12;
  const fiber = yield* browseLogs(session, 1762254000000).pipe(
    Effect.provideService(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.sync(() => columns),
        rows: Effect.sync(() => rows),
        size: Queue.unbounded<Terminal.Size, Cause.Done>(),
        readInput: Effect.succeed(input),
        readLine: Effect.die("unused"),
        display: (text) => Queue.offer(frames, text).pipe(Effect.asVoid),
      }),
    ),
    Effect.provide(
      Layer.mergeAll(mockOutput().layer, control.layer, Layer.mock(LogsClipboard, {})),
    ),
    Effect.forkScoped,
  );
  const frame = Effect.fnUntraced(function* (contains: string) {
    let text = "";
    while (!text.includes(contains)) text = yield* Queue.take(frames);
    return text;
  });
  return {
    input,
    frames,
    control,
    fiber,
    frame,
    resize: (width: number, height: number) => {
      columns = width;
      rows = height;
      process.stdout.emit("resize");
    },
  };
});

it.effect(
  "loads newer rows once and commits against navigation and resize performed while loading",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const pending = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      let calls = 0;
      const listeners = process.stdout.listenerCount("resize");
      const ui = yield* setup({
        mode: "append",
        load: (_end, emit) =>
          Effect.gen(function* () {
            calls++;
            if (calls === 3)
              return yield* Deferred.succeed(pending, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(stopped, undefined)),
              );
            for (let index = calls === 1 ? 0 : 20; index < (calls === 1 ? 20 : 30); index++)
              yield* emit({ id: String(index), ts_ms: index, message: `row-${index}` });
            if (calls === 2) yield* Deferred.await(release);
            return window;
          }),
      });
      expect(yield* ui.frame(" | ready")).toContain("row-19");
      yield* Queue.offer(ui.input, key("up"));
      yield* ui.frame("> Jan 01 - 00:00:00 UTC — row-18");
      yield* Queue.offer(ui.input, key("L"));
      const loading = yield* ui.frame("Loading newer logs");
      expect(loading).not.toContain("row-29");
      yield* Queue.offer(ui.input, key("l"));
      yield* ui.frame("Loading newer logs");
      expect(calls).toBe(2);
      yield* Queue.offer(ui.input, key("up"));
      yield* ui.frame("> Jan 01 - 00:00:00 UTC — row-17");
      yield* Queue.offer(ui.input, key("return"));
      yield* ui.frame("Log details");
      ui.resize(100, 8);
      yield* ui.frame("Log details");
      yield* Deferred.succeed(release, undefined);
      expect(yield* ui.frame("Newer logs loaded.")).toContain("row-17");
      yield* Queue.offer(ui.input, key("escape"));
      const refreshed = yield* ui.frame("Enter details");
      expect(refreshed).toContain("> Jan 01 - 00:00:00 UTC — row-17");
      expect(refreshed).not.toContain("row-29");
      yield* Queue.offer(ui.input, key("L"));
      yield* Deferred.await(pending);
      yield* Queue.offer(ui.input, key("q"));
      yield* Fiber.join(ui.fiber);
      yield* Deferred.await(stopped);
      expect(process.stdout.listenerCount("resize")).toBe(listeners);
    }),
);

it.effect(
  "replaces SQL rows by identity, keeps pinned details, and retries an atomic failed load",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const ui = yield* setup({
        mode: "replace",
        load: (_end, emit) =>
          Effect.gen(function* () {
            calls++;
            if (calls === 1) {
              yield* emit({ id: "a", message: "first" });
              yield* emit({ id: "b", message: "pinned original" });
            } else if (calls === 2) {
              yield* emit({ id: "b", message: "replacement" });
              yield* emit({ id: "a", message: "second" });
            } else if (calls === 3) {
              yield* emit({ id: "bad", message: "must not publish" });
              return yield* new LogsInputError({
                message: "A long recoverable failure ".repeat(10),
              });
            } else yield* emit({ id: "retry", message: "retried" });
            return window;
          }),
      });
      yield* ui.frame(" | ready");
      yield* Queue.offer(ui.input, key("down"));
      yield* ui.frame("pinned original");
      yield* Queue.offer(ui.input, key("return"));
      yield* ui.frame("Log details");
      yield* Queue.offer(ui.input, key("L"));
      expect(yield* ui.frame("Query reloaded.")).toContain("pinned original");
      yield* Queue.offer(ui.input, key("escape"));
      expect(yield* ui.frame("Enter details")).toContain("> — — replacement");
      yield* Queue.offer(ui.input, key("L"));
      const failed = yield* ui.frame("recoverable failure");
      expect(failed).not.toContain("must not publish");
      expect(failed.split("\r\n").at(-1)).toContain("L rerun");
      expect(failed).toContain("replacement");
      yield* Queue.offer(ui.input, key("L"));
      expect(yield* ui.frame("Query reloaded.")).toContain("retried");
      yield* Queue.offer(ui.input, key("q"));
      yield* Fiber.join(ui.fiber);
    }),
);

it.effect("keeps an empty result open for L and preserves raw Ctrl-C exit130", () =>
  Effect.gen(function* () {
    let calls = 0;
    const ui = yield* setup({
      mode: "append",
      load: (_end, emit) =>
        Effect.gen(function* () {
          calls++;
          if (calls > 1) yield* emit({ message: "arrived" });
          return window;
        }),
    });
    expect(yield* ui.frame(" | ready")).toContain("No log rows.");
    yield* Queue.offer(ui.input, key("L"));
    expect(yield* ui.frame("Newer logs loaded.")).toContain("arrived");
    yield* Queue.offer(ui.input, key("c", true));
    yield* Fiber.join(ui.fiber);
    expect(ui.control.exitCode).toBe(130);
  }),
);

it.effect("restores the terminal even if entering the alternate screen fails", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Terminal.UserInput>();
    const writes: string[] = [];
    const exit = yield* browseLogs({ mode: "append", load: () => Effect.succeed(window) }, 0).pipe(
      Effect.provideService(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(12),
          size: Queue.unbounded<Terminal.Size, Cause.Done>(),
          readInput: Effect.succeed(input),
          readLine: Effect.die("unused"),
          display: (text) =>
            Effect.gen(function* () {
              writes.push(text);
              if (writes.length === 1) return yield* Effect.die("partial display failure");
            }),
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          mockOutput().layer,
          mockProcessControl().layer,
          Layer.mock(LogsClipboard, {}),
        ),
      ),
      Effect.exit,
    );
    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("partial display failure");
    expect(writes).toEqual(["\u001b[?1049h\u001b[?25l", "\u001b[?25h\u001b[?1049l"]);
  }),
);
