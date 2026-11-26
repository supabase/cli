import { UiSchema } from "@effect/ui";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer, Schema } from "effect";

import { Terminal, TerminalHost, TerminalTheme } from "./index.ts";
import { TerminalTest } from "./testing/index.ts";

const Status = Terminal.component({
  name: "Status",
  model: Schema.Struct({}),
  message: UiSchema.TaggedEnum({ Never: {} }),
}).make({
  init: () => ({}),
  update: { Never: ($) => $.model },
  view: (h) => h.text.style({ tone: "accent", bold: true }).children("ready"),
});

const withTerminal = <A, E>(
  env: Record<string, string>,
  body: (terminal: TerminalTest.TestTerminal) => Effect.Effect<A, E>,
) => TerminalTest.withTestTerminal({ columns: 40, rows: 8, env }, body);

const outputOf = (env: Record<string, string>, theme?: TerminalTheme.ThemeSpec) =>
  withTerminal(env, (t) =>
    Effect.gen(function* () {
      const fiber = yield* TerminalTest.startOn(
        t,
        TerminalHost.run(Status, {}, { renderer: { theme } }),
      );
      yield* t.untilScreen((rows) => rows.includes("ready"));
      yield* Fiber.interrupt(fiber);
      return yield* t.output;
    }),
  );

describe("terminal environment", () => {
  it.effect("draws tone colors and bold on a color terminal", () =>
    Effect.gen(function* () {
      const bytes = yield* outputOf({ TERM: "xterm-256color" });
      expect(bytes).toContain("\u001b[1;36mready");
    }),
  );

  it.effect("keeps bold but drops tone colors under NO_COLOR", () =>
    Effect.gen(function* () {
      const bytes = yield* outputOf({ TERM: "xterm-256color", NO_COLOR: "1" });
      expect(bytes).toContain("\u001b[1mready");
      // oxlint-disable-next-line no-control-regex -- matching the ESC byte of an SGR color is the point
      expect(bytes).not.toMatch(/\u001b\[[0-9;]*(?:3[0-7]|9[0-7]|38)[;m]/);
    }),
  );

  it.effect("draws a replacement theme's tones", () =>
    Effect.gen(function* () {
      const theme: TerminalTheme.ThemeSpec = {
        tones: { ...TerminalTheme.defaultTheme.tones, accent: { ansi16: "magenta" } },
      };
      const bytes = yield* outputOf({ TERM: "xterm-256color" }, theme);
      expect(bytes).toContain("\u001b[1;35mready");
    }),
  );

  it.effect("fails with NonInteractive on TERM=dumb before writing anything", () =>
    withTerminal({ TERM: "dumb" }, (t) =>
      Effect.gen(function* () {
        const error = yield* TerminalHost.run(Status, {}).pipe(
          Effect.provideService(TerminalHost.Transport, t.terminal),
          Effect.flip,
        );
        expect(error).toMatchObject({ _tag: "NonInteractive", reason: "dumb-terminal" });
        expect(yield* t.output).toBe("");
        expect(yield* t.rawModeTransitions).toEqual([]);
      }),
    ),
  );
});

const pipe = (isTTY: boolean, writes: Array<string>) => ({
  isTTY,
  write: (chunk: string) => {
    writes.push(chunk);
  },
  on: () => {},
  off: () => {},
});

describe("without a terminal", () => {
  it.effect.each([
    { name: "stdin", input: false, output: true, reason: "stdin-not-tty" },
    { name: "stdout", input: true, output: false, reason: "stdout-not-tty" },
  ] as const)("fails with NonInteractive when $name is not a TTY and writes no bytes", (row) =>
    Effect.gen(function* () {
      const writes: Array<string> = [];
      const terminal = TerminalHost.makeTransport({
        input: { ...pipe(row.input, []), resume: () => {}, pause: () => {} },
        output: pipe(row.output, writes),
        env: { TERM: "xterm-256color" },
      });

      const error = yield* TerminalHost.run(Status, {}).pipe(
        Effect.provideService(TerminalHost.Transport, terminal),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "NonInteractive", reason: row.reason });
      expect(writes).toEqual([]);
    }),
  );
});

describe("process terminal configuration", () => {
  const capabilitiesUnder = (values: Record<string, string>) =>
    TerminalHost.Transport.useSync((terminal) => terminal.capabilities).pipe(
      Effect.provide(
        TerminalHost.layerProcess.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
        ),
      ),
    );

  it.effect("reads color forcing from Config", () =>
    Effect.gen(function* () {
      expect(yield* capabilitiesUnder({ FORCE_COLOR: "3" })).toMatchObject({
        colorLevel: 3,
        isStyled: true,
      });
    }),
  );

  it.effect("ignores an empty FORCE_COLOR from Config", () =>
    Effect.gen(function* () {
      expect(yield* capabilitiesUnder({ FORCE_COLOR: "", TERM: "dumb" })).toMatchObject({
        colorLevel: 0,
        isStyled: false,
      });
    }),
  );

  it.effect("lets NO_COLOR from Config win over forced color", () =>
    Effect.gen(function* () {
      expect(yield* capabilitiesUnder({ NO_COLOR: "1", FORCE_COLOR: "3" })).toMatchObject({
        colorLevel: 0,
      });
    }),
  );
});
