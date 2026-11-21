import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Queue } from "effect";

import { TestTerminal } from "../terminal/testing.ts";
import * as Theme from "../theme/theme.ts";
import { text } from "../view/view.ts";
import { run } from "./run.ts";
import { frame, scripted, withTerminal, Written, type Frame } from "./test-support.ts";
import type { TestTerminalOptions } from "../terminal/testing.ts";

const ESC = "\u001b";
const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Starts with one committed line so even plain output writes at startup, then finishes on a final frame. */
const runToCompletion = (live: Frame["live"]) =>
  Effect.gen(function* () {
    const test = yield* TestTerminal;
    const written = yield* Written;
    const inbox = yield* Queue.unbounded<Frame>();
    const running = yield* run(
      scripted(inbox, frame(["working"], { committed: ["step one"] })),
    ).pipe(Effect.forkScoped({ startImmediately: true }));

    yield* written.next;
    yield* Queue.offer(inbox, frame(live, { committed: ["step one"], done: true }));
    expect(yield* Fiber.join(running)).toBe("done");

    return yield* test.rawBytes;
  });

const inEnvironment = (options: Partial<TestTerminalOptions>, live: Frame["live"]) =>
  withTerminal(runToCompletion(live), options);

const coral: Theme.ThemeSpec = {
  tones: { ...Theme.defaultTheme.tones, danger: { ansi256: 209, ansi16: "red" } },
};

const emphasized = [text("all done", { tone: "danger", emphasis: "bold" })];

const toned = [text("all done", { tone: "danger" })];

describe("Tui.run output environments", () => {
  it.effect("writes plain lines without escape sequences when TERM is dumb", () =>
    Effect.gen(function* () {
      const bytes = yield* inEnvironment({ env: { TERM: "dumb" } }, ["all done"]);

      expect(bytes).toBe("step one\nall done\n");
    }),
  );

  it.effect("writes plain lines without escape sequences when output is not a TTY", () =>
    Effect.gen(function* () {
      const bytes = yield* inEnvironment({ isTTY: false }, toned);

      expect(bytes).toBe("step one\nall done\n");
    }),
  );

  it.effect("writes only SGR sequences when output is not a TTY and FORCE_COLOR is set", () =>
    Effect.gen(function* () {
      const bytes = yield* inEnvironment({ isTTY: false, env: { FORCE_COLOR: "1" } }, toned);

      expect(bytes).toMatch(sgr);
      expect(bytes.replace(sgr, "")).toBe("step one\nall done\n");
    }),
  );

  it.effect("keeps emphasis but writes no colors when NO_COLOR is set on a TTY", () =>
    Effect.gen(function* () {
      const bytes = yield* inEnvironment(
        { env: { TERM: "xterm-256color", NO_COLOR: "1" } },
        emphasized,
      );

      expect(bytes.match(sgr)).toEqual([`${ESC}[1m`, `${ESC}[0m`]);
    }),
  );

  it.effect("writes the terminal's own palette by default", () =>
    Effect.gen(function* () {
      const bytes = yield* inEnvironment({ env: { TERM: "xterm-256color" } }, emphasized);

      expect(bytes).toContain(`${ESC}[1;31mall done${ESC}[0m`);
    }),
  );

  it.effect("writes the palette of a theme the host provides", () =>
    Effect.gen(function* () {
      const bytes = yield* inEnvironment({ env: { TERM: "xterm-256color" } }, emphasized).pipe(
        Effect.provide(Theme.layer(coral)),
      );

      expect(bytes).toContain(`${ESC}[1;38;5;209mall done${ESC}[0m`);
    }),
  );
});
