import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import { mockOutput, mockStdin, mockTty } from "../../tests/helpers/mocks.ts";
import { Output } from "../shared/output/output.service.ts";
import { Stdin } from "../shared/runtime/stdin.service.ts";

import { parseYesNo, promptYesNo, promptYesNoOutcome } from "./prompt-yes-no.ts";

describe("parseYesNo", () => {
  it("parses affirmative answers (case-insensitive, trimmed)", () => {
    for (const input of ["y", "Y", "yes", "YES", " Yes ", "yEs"]) {
      expect(parseYesNo(input)).toBe(true);
    }
  });

  it("parses negative answers (case-insensitive, trimmed)", () => {
    for (const input of ["n", "N", "no", "NO", " No ", "nO"]) {
      expect(parseYesNo(input)).toBe(false);
    }
  });

  it("returns undefined for unparseable or empty input", () => {
    for (const input of ["", "  ", "maybe", "yeah", "1", "true", "yep"]) {
      expect(parseYesNo(input)).toBeUndefined();
    }
  });
});

describe("promptYesNo machine consent", () => {
  for (const format of ["json", "stream-json"] as const) {
    it.effect.each([
      {
        readMachineStdin: false,
        stdinIsTty: false,
        interactive: true,
        defaultValue: false,
        expected: false,
        reads: 0,
      },
      {
        readMachineStdin: true,
        stdinIsTty: true,
        interactive: true,
        defaultValue: false,
        expected: false,
        reads: 0,
      },
      {
        readMachineStdin: true,
        stdinIsTty: false,
        interactive: false,
        defaultValue: false,
        expected: false,
        reads: 0,
      },
      {
        readMachineStdin: true,
        stdinIsTty: false,
        interactive: true,
        defaultValue: false,
        expected: true,
        reads: 1,
      },
      {
        readMachineStdin: true,
        stdinIsTty: false,
        interactive: false,
        defaultValue: true,
        expected: true,
        reads: 0,
      },
    ])(`${format} respects opt-in and input ownership: %j`, (scenario) =>
      Effect.gen(function* () {
        const out = mockOutput({ format });
        let reads = 0;
        const stdin = Layer.succeed(Stdin, {
          isTTY: scenario.stdinIsTty,
          readPipedBytes: Effect.die("unexpected whole-stream read"),
          pipedBytesStream: Stream.empty,
          readPipedText: Effect.die("unexpected whole-stream read"),
          readLine: () =>
            Effect.sync(() => {
              reads++;
              return Option.some("y");
            }),
        });
        const answer = yield* Effect.gen(function* () {
          const output = yield* Output;
          return yield* promptYesNo(
            output,
            false,
            "Confirm?",
            scenario.defaultValue,
            scenario.interactive,
            { readMachineStdin: scenario.readMachineStdin },
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(out.layer, stdin, mockTty({ stdinIsTty: scenario.stdinIsTty })),
          ),
        );
        expect(answer).toBe(scenario.expected);
        expect(reads).toBe(scenario.reads);
        expect(out.stderrText).toBe(scenario.reads === 1 ? "Confirm? [y/N] y\n" : "");
      }),
    );
  }
});

describe("promptYesNoOutcome piped answers", () => {
  const outcome = (piped: string) =>
    Effect.gen(function* () {
      const output = yield* Output;
      return yield* promptYesNoOutcome(output, false, "Confirm?", false);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(mockOutput().layer, mockStdin(false, piped), mockTty({ stdinIsTty: false })),
      ),
    );

  it.effect("reports closed stdin as unanswered, taking the default", () =>
    Effect.gen(function* () {
      expect(yield* outcome("")).toEqual({ value: false, answered: false });
    }),
  );

  it.effect.each([
    ["\n", false],
    ["n\n", false],
    ["y\n", true],
  ] as const)("reports the piped line %j as an answer", ([piped, value]) =>
    Effect.gen(function* () {
      expect(yield* outcome(piped)).toEqual({ value, answered: true });
    }),
  );
});

describe("promptYesNo piped text answers", () => {
  const ask = (piped: string, defaultValue: boolean, interactive = true) =>
    Effect.gen(function* () {
      const output = yield* Output;
      return yield* promptYesNo(output, false, "Confirm?", defaultValue, interactive);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(mockOutput().layer, mockStdin(false, piped), mockTty({ stdinIsTty: false })),
      ),
    );

  it.effect.each(["u", "yess", "nope", "   "])(
    "declines the unrecognised answer %j whatever the default",
    (answer) =>
      Effect.gen(function* () {
        expect(yield* ask(`${answer}\n`, true)).toBe(false);
        expect(yield* ask(`${answer}\n`, false)).toBe(false);
      }),
  );

  it.effect("keeps the default for an unrecognised line under interactive: false", () =>
    Effect.gen(function* () {
      expect(yield* ask("echo next-step\n", true, false)).toBe(true);
      expect(yield* ask("echo next-step\n", false, false)).toBe(false);
      expect(yield* ask("   \n", true, false)).toBe(true);
    }),
  );

  it.effect.each([true, false])("takes the default %j for an empty line or closed stdin", (def) =>
    Effect.gen(function* () {
      for (const interactive of [true, false]) {
        expect(yield* ask("\n", def, interactive)).toBe(def);
        expect(yield* ask("", def, interactive)).toBe(def);
      }
    }),
  );

  it.effect("reads a blank line as present, then the next answer", () =>
    Effect.gen(function* () {
      const output = yield* Output;
      const { readLine } = yield* Stdin;
      const first = yield* promptYesNo(output, false, "Confirm?", true);
      const second = yield* promptYesNo(output, false, "Confirm?", true);
      const lines = [first, second, yield* readLine(0), yield* readLine(0)];
      expect(lines).toEqual([true, false, Option.some(""), Option.none()]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          mockOutput().layer,
          mockStdin(false, "\nn\n\n"),
          mockTty({ stdinIsTty: false }),
        ),
      ),
    ),
  );

  it.effect.each([
    ["y", true],
    ["yes", true],
    ["n", false],
    ["no", false],
  ] as const)("honours %j over the opposite default", ([answer, expected]) =>
    Effect.gen(function* () {
      expect(yield* ask(`${answer}\n`, !expected)).toBe(expected);
      expect(yield* ask(`${answer}\n`, !expected, false)).toBe(expected);
    }),
  );
});
